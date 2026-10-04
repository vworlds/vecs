import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  RPC_CLOSED_CODE,
  RPCError,
  Server2Client,
  SessionRPC,
  StateDiff,
  ALL_COMPONENTS,
  cid_pack,
  encodeRelationshipSnapshot,
  NetworkWorld,
  type NetworkWorldOptions,
  type RemovedComponent,
  type RPCHandler,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { performance } from "node:perf_hooks";
import {
  type ComponentInstance,
  type ComponentClass,
  type EID,
  type Entity,
  Exclusive,
  insertPhaseAfter,
  ON_STORE,
  Phase,
  Relationship,
  type System,
} from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { HISTORY_LENGTH, History } from "./history.js";
import { NetworkClient, NetworkInput, Networked } from "./networked.js";
import { TrackerCache, View } from "./view.js";

interface RegisteredComponent {
  Class: ComponentClass;
  wireType: number;
  eid: EID;
}

interface Update {
  entity: Entity;
  wireType: number;
  component: ComponentInstance | undefined; // undefined => removal
}

/**
 * Identifies the connection that invoked a server RPC handler.
 *
 * Passed as the third argument to every handler registered with
 * {@link ServerWorld.handleRpc}, so a shared handler can act on behalf of the
 * caller instead of guessing which session a request came from. Each session
 * gets its own context, so concurrent connections — and connections to
 * different named worlds under one `VecsListener` — never see each other's
 * caller.
 */
export interface ServerRPCContext {
  /** The `ServerWorld` that owns the calling session. */
  readonly world: ServerWorld;
  /**
   * The calling session's `NetworkClient` entity, carrying its
   * {@link NetworkClient.id}, its {@link View}, and whatever the application
   * attached while authenticating the session.
   */
  readonly caller: Entity;
  /** Id of the calling connection, equal to the caller's `NetworkClient.id`. */
  readonly connectionId: string;
}

export interface ServerWorldOptions extends NetworkWorldOptions {
  name?: string;
  encodeBufferSize?: number;
  disconnectGraceMs?: number;
}

class ServerClientSession {
  public readonly baseFrame: number;
  public readonly history: History;
  public readonly rpc = new SessionRPC();
  public context!: ServerRPCContext;
  public ackFrame: number;
  public lastSeenMs = 0;
  public needsFullSnapshot = true;
  public needsResync = false;
  /**
   * Set by {@link ServerWorld.closeSession}. The session is finished as far as
   * the application is concerned: it stops accepting input and stops
   * replicating, but its RPC outbox still needs one flush so a rejection that
   * explains the close can reach the client. {@link ServerWorld.send} finishes
   * the teardown.
   */
  public closing = false;
  public closed = false;
  public socket!: VecsSocket;
  public entity!: Entity;

  public constructor(lastFrame = -1) {
    this.baseFrame = lastFrame;
    this.ackFrame = lastFrame;
    this.history = new History(HISTORY_LENGTH, lastFrame);
  }
}

/**
 * An authoritative world that replicates to connected clients.
 *
 * Each accepted connection gets a `NetworkClient` entity carrying a {@link View}
 * and a server-local session; the entity's lifecycle *is* the connection
 * lifecycle, so attaching components from an RPC handler is how an application
 * authenticates or otherwise binds the session, and destroying the entity closes
 * the connection. Register per-connection behaviour with
 * {@link ServerWorld.handleRpc} and end connections with
 * {@link ServerWorld.closeSession}; no session bookkeeping is exposed.
 */
export class ServerWorld extends NetworkWorld {
  public readonly name: string;
  private readonly _components: readonly RegisteredComponent[];
  private readonly _sessions = new Map<string, ServerClientSession>();
  private readonly _rpcHandlers = new Map<number, RPCHandler<ServerRPCContext>>();
  private readonly _updates = new Map<number, Update>();
  private readonly _snapshotCache = new Map<number, EncodedSnapshot>();
  private readonly _trackerCache: TrackerCache;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _disconnectGraceMs: number;
  private _clients!: System<[typeof View, typeof ServerClientSession]>;
  private _frame = 1;

  public constructor(options: ServerWorldOptions = {}) {
    super(options);
    this.name = options.name ?? "main";
    const encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this._encodeBuffer = new Uint8Array(encodeBufferSize);
    this._disconnectGraceMs = options.disconnectGraceMs ?? 10_000;
    this._trackerCache = new TrackerCache(this);
    this._components = this.networkComponents;
    ensureRegistered(this, Networked);
    ensureRegistered(this, NetworkClient);
    ensureRegistered(this, NetworkInput);
    ensureRegistered(this, View);
    ensureRegistered(this, ServerClientSession);
    this.component(Networked).on("remove", (entity) => {
      this._record(entity, ALL_COMPONENTS, undefined);
    });
    this.component(ServerClientSession).on("remove", (_entity, session) => {
      this._endSession(session);
    });

    // Interest refresh, snapshot capture and send all run in a dedicated phase
    // inserted after ON_STORE, so they execute strictly after every user system
    // (in any phase, including PRE_STORE and ON_STORE). Phase order, not system
    // registration order, enforces this: a client can retarget its own InCell or
    // swap its View DSL from any user phase and the refresh here installs the new
    // tracker the same tick, so the viewer is never dropped from its own view for
    // a frame on a cell crossing.
    const storePhase = this.entity(`ServerWorld:${this.name}:Store`).add(Phase);
    insertPhaseAfter(storePhase, this.entity(ON_STORE));

    this._clients = this.system(`ServerWorld:${this.name}:View`)
      .with(View, ServerClientSession)
      .phase(storePhase)
      .update(
        { watch: View, onEnter: true, inject: [ServerClientSession] },
        (_entity, view, [_session]) => {
          view._refreshTracker(this._trackerCache);
        }
      )
      .exit([View, ServerClientSession], (_entity, [view, _session]) => {
        view._releaseTrackers(this._trackerCache);
      })
      .track();
    this._components.forEach((registered) => {
      this.system(`ServerWorld:${this.name}:${registered.Class.name}`)
        .with(Networked, registered.Class)
        .phase(storePhase)
        .update({ watch: registered.Class, onEnter: true }, (entity, component) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.wireType));
          this._record(entity, registered.wireType, component);
        })
        .exit((entity) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.wireType));
          this._record(entity, registered.wireType, undefined);
        })
        .track();
    });

    this.system(`ServerWorld:${this.name}:Send`)
      .phase(storePhase)
      .run(() => this.send());
  }

  /** @internal */
  public _attach(listener: VecsSocketListener): void {
    listener.on("new", (socket) => this._onNewConnection(socket));
  }

  /**
   * Register the handler for an incoming `rpcId`, replacing any previous one and
   * applying to sessions that are already connected.
   *
   * The handler is invoked as `handler(params, request, context)`, where
   * `context` is the calling connection's {@link ServerRPCContext}. Every
   * session sees its own caller, so one shared handler can authenticate, look
   * up, or attribute work per connection.
   *
   * ```ts
   * const AUTH_RPC = 101;
   * const AUTH_REJECTED = 4001;
   *
   * world.handleRpc(AUTH_RPC, (params, _request, ctx) => {
   *   const [resumeToken] = params as [string];
   *   if (!sessions.authenticate(ctx.connectionId, resumeToken)) {
   *     throw new RPCError(AUTH_REJECTED, "unknown resume token");
   *   }
   *   ctx.caller.set(Authenticated, { playerId: ctx.connectionId });
   * });
   * ```
   *
   * @param rpcId - Request id to answer.
   * @param handler - Handler run for every connection; see {@link RPCHandler}.
   */
  public handleRpc(rpcId: number, handler: RPCHandler<ServerRPCContext>): void {
    this._rpcHandlers.set(rpcId, handler);
    this._sessions.forEach((session) => {
      if (!session.closing) {
        this._installHandler(session, rpcId, handler);
      }
    });
  }

  /**
   * Close one connection and tear its session down.
   *
   * Cleanup runs exactly once: the session leaves the world, its `NetworkClient`
   * entity is destroyed — firing every `NetworkClient` exit system — and its
   * socket is closed. Closing a connection that is already gone is a no-op that
   * returns `false`, so shutdown loops can call it unconditionally.
   *
   * The close is graceful, because the common case has to explain itself: a
   * handler rejects an `auth` call with an {@link RPCError} *and* closes the
   * connection, and the client needs that code to tell a wrong world from a bad
   * credential. The session is therefore marked *closing* rather than destroyed
   * on the spot. It immediately stops accepting input and replicates nothing
   * further, and the next {@link ServerWorld.send} flushes the RPC replies it
   * still owes — best effort over an unreliable datagram channel — and then
   * completes the same teardown. So `closeSession` returning `true` means the
   * close was scheduled, and the socket closes on the next tick, not before it.
   *
   * Peers that go away on their own, applications that destroy the
   * `NetworkClient` entity, and `disconnectGraceMs` expiry all tear down
   * immediately instead: there is nobody left to explain anything to.
   *
   * ```ts
   * // newest authenticated connection wins
   * for (const previous of sessions.forPlayer(playerId)) {
   *   world.closeSession(previous.connectionId, `superseded by ${ctx.connectionId}`);
   * }
   * ```
   *
   * To close every connection at shutdown, query `NetworkClient` entities rather
   * than reaching into session internals:
   *
   * ```ts
   * world
   *   .query("shutdown:clients")
   *   .with(NetworkClient)
   *   .track()
   *   .build()
   *   .forEach((entity) => {
   *     world.closeSession(entity, "server shutting down");
   *   });
   * ```
   *
   * @param connection - The connection id (`NetworkClient.id`) or the
   *   session's `NetworkClient` entity.
   * @param reason - Recorded on the caller's `NetworkClient.closeReason` before
   *   the entity is destroyed, so an exit system can log why the server hung up.
   * @returns `true` when a live session was scheduled to close.
   */
  public closeSession(connection: string | Entity, reason?: string): boolean {
    const session = this._sessionFor(connection);
    if (!session) {
      return false;
    }
    if (reason !== undefined) {
      session.entity.getMut(NetworkClient, (client) => {
        client.closeReason = reason;
      });
    }
    session.closing = true;
    return true;
  }

  /**
   * Advance one replication frame: reconcile every session's view, record the
   * frame's diff, and send each session what it has not acked, together with
   * any queued RPC replies. Sessions that have not sent anything within
   * `disconnectGraceMs` are closed.
   *
   * Registered as the world's own `Send` system in a phase after `ON_STORE`, so
   * it normally runs as part of `progress()`; call it directly only to drive a
   * world that has no tick loop.
   */
  public send(): void {
    const toFrame = this._frame++;
    if (this._sessions.size === 0) {
      this._updates.clear();
      return;
    }

    const nowMs = performance.now();
    const staleSessions: ServerClientSession[] = [];

    this._clients.forEach([View, ServerClientSession], (e, [view, session]) => {
      if (session.closing) {
        // Scheduled to close: no further state, but the rejection that explains
        // the close still owes the client a frame.
        this._finishClose(session);
        return;
      }

      view._reconcileVisibility();
      view._releaseOldTracker(this._trackerCache);

      if (session.ackFrame < toFrame - HISTORY_LENGTH) {
        session.needsFullSnapshot = true;
        session.needsResync = true;
      }
      if (session.needsResync) {
        view._resyncAll();
      }

      const snapshots: EncodedSnapshot[] = [];
      const removed: RemovedComponent[] = [];

      view._exitedView.forEach((entity) => {
        removed.push([entity.eid, ALL_COMPONENTS]);
      });
      view._enteredView.forEach((entity) => {
        this._pushEntitySnapshots(entity, snapshots);
      });

      this._updates.forEach((u) => {
        if (view._enteredView.has(u.entity) || !view.canSee(u.entity)) {
          return;
        }
        if (u.component) {
          snapshots.push(this._encodeSnapshot(u.entity, u.wireType, u.component));
        } else {
          removed.push([u.entity.eid, u.wireType]);
        }
      });

      view._enteredView.clear();
      view._exitedView.clear();

      const latest = new StateDiff({
        fromFrame: toFrame - 1,
        toFrame,
        snapshots,
        removed,
      });
      session.history.push(latest);

      if (nowMs - session.lastSeenMs > this._disconnectGraceMs) {
        staleSessions.push(session);
        return;
      }

      const rpc = session.rpc.getOutgoing();
      let diff: StateDiff;
      if (session.needsResync) {
        diff = new StateDiff({
          fromFrame: 0,
          toFrame,
          snapshots: latest.snapshots,
          removed: latest.removed,
        });
      } else {
        diff = session.history.pull(session.ackFrame, toFrame);
        if (session.needsFullSnapshot && diff.fromFrame !== 0) {
          diff = new StateDiff({
            fromFrame: 0,
            toFrame: diff.toFrame,
            snapshots: diff.snapshots,
            removed: diff.removed,
          });
        }
      }

      if (diff.snapshots.length === 0 && diff.removed.length === 0 && rpc.length === 0) {
        return;
      }
      session.socket.send(this._encode(new Server2Client({ diff, rpc })));
    });

    staleSessions.forEach((session) => {
      session.entity.getMut(NetworkClient, (client) => {
        client.closeReason = "disconnect grace period elapsed";
      });
      session.entity.destroy();
    });

    this._updates.clear();
  }

  private _onNewConnection(socket: VecsSocket): void {
    const entity = this.entity().add(Networked).add(NetworkClient).add(View);
    const session = new ServerClientSession(this._frame - 1);
    session.socket = socket;
    session.entity = entity;
    session.context = { world: this, caller: entity, connectionId: socket.id };
    session.lastSeenMs = performance.now();
    entity.attach(session);
    entity.set(NetworkClient, { id: socket.id });
    this._rpcHandlers.forEach((handler, rpcId) => this._installHandler(session, rpcId, handler));
    this._sessions.set(socket.id, session);

    socket.on("receive", (data) => this._receive(session, data));
    socket.on("disconnect", () => this._onDisconnect(socket.id));
  }

  private _onDisconnect(socketId: string): void {
    const session = this._sessions.get(socketId);
    if (!session) {
      return;
    }
    session.entity.destroy();
  }

  private _receive(session: ServerClientSession, data: Uint8Array): void {
    // A transport can deliver frames it had already queued when the session was
    // torn down; the socket has no `off`, so drop them here. A closing session
    // drops them too: it has stopped accepting work, and the only thing still
    // owed is the reply `send` is flushing.
    if (session.closed || session.closing) {
      return;
    }
    session.lastSeenMs = performance.now();
    const message = new Decoder(data).read(Client2Server);
    if (message.ackFrame <= session.history.lastFrame) {
      session.ackFrame = Math.max(session.ackFrame, message.ackFrame);
      if (session.ackFrame > session.baseFrame) {
        session.needsFullSnapshot = false;
        session.needsResync = false;
      }
    }
    if (message.input !== undefined) {
      session.entity.set(NetworkInput, { input: message.input });
    }
    if (message.rpc.length > 0) {
      session.rpc.process(message.rpc);
    }
  }

  /**
   * Bind a world-level handler to one session, closing over that session's
   * caller context. `SessionRPC` itself has no notion of a caller, so the
   * binding happens here: each session gets its own closure.
   */
  private _installHandler(
    session: ServerClientSession,
    rpcId: number,
    handler: RPCHandler<ServerRPCContext>
  ): void {
    session.rpc.listen(rpcId, (params, request) => handler(params, request, session.context));
  }

  private _sessionFor(connection: string | Entity): ServerClientSession | undefined {
    if (typeof connection === "string") {
      return this._sessions.get(connection);
    }
    if (connection.world !== this) {
      return undefined;
    }
    const session = connection.get(ServerClientSession) as ServerClientSession | undefined;
    return session && !session.closed ? session : undefined;
  }

  /**
   * Complete a {@link ServerWorld.closeSession}: flush the RPC replies the
   * session still owes, then run the normal exactly-once teardown.
   *
   * The flush is best effort — the transport is an unreliable datagram channel —
   * but it is the reason {@link ServerWorld.closeSession} defers: a client that
   * asked a question deserves the answer, and a rejection is usually the whole
   * point of the close. A session with nothing owed tears down without emitting
   * a frame at all.
   */
  private _finishClose(session: ServerClientSession): void {
    const rpc = session.rpc.getOutgoing();
    if (rpc.length > 0) {
      session.socket.send(this._encode(new Server2Client({ rpc })));
    }
    // Destroying the entity lands in the `ServerClientSession` remove hook, which
    // is what removes the session and closes the socket.
    session.entity.destroy();
  }

  /**
   * Single teardown path, driven by removal of the `ServerClientSession`
   * component. Whoever ends the session — the peer disconnecting, the grace
   * period elapsing, `closeSession` finishing, or the application destroying the
   * `NetworkClient` entity — the entity destroy lands here, and the `closed`
   * guard keeps it to exactly one pass.
   */
  private _endSession(session: ServerClientSession): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    const { connectionId } = session.context;
    if (this._sessions.get(connectionId) === session) {
      this._sessions.delete(connectionId);
    }
    // Nothing can be answered by a session that no longer exists, and a server
    // never issues calls of its own, so this only ever drops cached replies.
    session.rpc.abortPending(
      new RPCError(RPC_CLOSED_CODE, `connection ${connectionId} closed by the server`)
    );
    session.socket.close();
  }

  private _record(
    entity: Entity,
    wireType: number,
    component: ComponentInstance | undefined
  ): void {
    this._updates.set(cid_pack(entity.eid, wireType), { entity, wireType, component });
  }

  private _pushEntitySnapshots(entity: Entity, snapshots: EncodedSnapshot[]): void {
    this._components.forEach((registered) => {
      const component = entity.get(registered.eid);
      if (!component) {
        return;
      }
      snapshots.push(this._encodeSnapshot(entity, registered.wireType, component));
    });
  }

  private _encodeSnapshot(
    entity: Entity,
    wireType: number,
    component: ComponentInstance
  ): EncodedSnapshot {
    const eid = entity.eid;
    const cid = cid_pack(eid, wireType);
    const cached = this._snapshotCache.get(cid);
    if (cached) {
      return cached;
    }

    const payloadEncoder = new Encoder(this._encodeBuffer);
    if (component instanceof Relationship) {
      const Class = component.constructor as ComponentClass<Relationship>;
      const targetEids = [...entity.targets(Class)]
        .map((target) => target.eid)
        .sort((a, b) => a - b);
      if (targetEids.length > 1 && this.entity(Class).has(Exclusive)) {
        throw new Error(`Exclusive relationship ${Class.name} has ${targetEids.length} targets`);
      }
      encodeRelationshipSnapshot(payloadEncoder, targetEids, component);
    } else {
      payloadEncoder.write(component);
    }
    const payload = payloadEncoder.getBuffer().slice();
    const snapshot = new EncodedSnapshot(
      this._encode(new ComponentSnapshot({ eid, wireType, payload })),
      eid,
      wireType
    );
    this._snapshotCache.set(cid, snapshot);
    return snapshot;
  }

  private _encode(value: IEncodable): Uint8Array {
    const encoder = new Encoder(this._encodeBuffer);
    encoder.write(value);
    return encoder.getBuffer().slice();
  }
}

function ensureRegistered(world: NetworkWorld, Class: ComponentClass): void {
  if (!world.getEntity(Class)) {
    world.component(Class);
  }
}
