import {
  CLOSE_PROTOCOL_ERROR_CODE,
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
  type CloseNotice,
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
import {
  HISTORY_LENGTH,
  History,
  validateHistoryFrames,
  validateRedundancyFrames,
} from "./history.js";
import { NetworkClient, NetworkInput, Networked } from "./networked.js";
import { RttEstimator } from "./rtt.js";
import { SentFrames } from "./sent_frames.js";
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
  /**
   * How long a closing session waits, in wall-clock milliseconds, for the
   * client to acknowledge the frame carrying the replies the close still owes
   * before the transport is torn down — the close linger. Defaults to
   * {@link DEFAULT_CLOSE_LINGER_MS}.
   *
   * The linger exists because the transport is an unreliable datagram channel:
   * closing the socket in the same turn as the flush discards the queued or
   * in-flight frame, and the client would never see the rejection that
   * explains the close. While the linger runs the flush frame is retransmitted
   * on every {@link ServerWorld.send}, so a lost datagram gets another
   * chance, and the close happens as soon as the ack arrives — usually one
   * client ack interval plus a round trip. The deadline is the bound for a
   * client that never acks: a dead or silent peer cannot hold its session
   * open longer than this. `0` still flushes once, then closes on the next
   * `send()`.
   */
  closeLingerMs?: number;
  /**
   * How many frames of replication history each session keeps. A client can be
   * caught up with a delta only while everything it is missing is still in that
   * history, so this is how far behind its newest ack can fall while its view
   * keeps changing. An integer of at least 2; defaults to `64`, about two seconds
   * at 30 Hz. The constructor throws for any other value.
   *
   * A client acks the newest frame it has received, and that ack reaches the
   * server a round trip, plus up to one client ack interval, after the frame
   * was sent: at 30 Hz and a 200 ms round trip it is already about 8 frames
   * old. The server answers an ack with a delta only while everything the
   * client is missing is still in the history. Once a frame with content (a
   * snapshot or a removal) that the client has not acked has left the last
   * `historyFrames` frames, the client cannot be caught up, and the server
   * sends it a full baseline instead: the client destroys and rebuilds every
   * replicated entity from it. A baseline is sent once and then awaited, not
   * repeated every frame: the server sends the session no more state until the
   * client acks the baseline, and sends another only when it presumes the first
   * lost: after twice the session's smoothed ack round trip (never less than
   * 100 ms), or after one second before the first measurement. It does not back
   * off. A large baseline is often lost on a lossy link, and recovering from
   * that soon matters more than the rebuilds an ack path that stays dead costs.
   *
   * Only frames with content count. The server sends nothing for an empty diff,
   * so a client's ack stops advancing while its view is quiet; a frame that
   * leaves the history empty took nothing with it, so a client whose view did
   * not change is served a delta from an ack of any age, and is never sent a
   * baseline just for being quiet.
   *
   * Pick a window of about two and a half times your slowest players' ack lag,
   * `tickRateHz * (roundTripMs + ackIntervalMs) / 1000` frames. A baseline holds
   * state back for a round trip, so right after one (or after any stall) the
   * lag peaks at twice its steady size, and a window shorter than that rebuilds
   * the client about once per window, over and over. A longer window costs one
   * retained `StateDiff` per frame per session, and a lagging client's delta
   * merges the frames since its ack on every send.
   */
  historyFrames?: number;
  /**
   * Opt in to the optimistic base: send a healthy session each frame as a delta
   * from `max(ack, base)`, where `base` is the frame the session was sent
   * `redundancyFrames` sends ago (a send is a baseline or a delta with content),
   * instead of from the client's newest ack. A change then travels in
   * `redundancyFrames` consecutive frames, however sparse the traffic is, not in
   * every frame until it is acked. An integer of at least 1 and less than
   * {@link ServerWorldOptions.historyFrames}; the constructor throws for any
   * other value. Unset by default, which keeps today's behavior and a
   * byte-identical wire.
   *
   * Without it a change that is not superseded is sent again in every frame until
   * its ack arrives, which costs `ackLag + 1` times its size: 7 times at 30 Hz
   * and a 200 ms round trip. With it a change costs `redundancyFrames` times,
   * whatever the lag, and `redundancyFrames - 1` lost frames in a row cost the
   * client nothing. `1` sends every change once.
   *
   * The base is always a frame the client was sent, because the client's version
   * is one. In a view that changes on every frame it is `frame - redundancyFrames`.
   * In a sparse one the frames sent are far apart and the base is the one
   * `redundancyFrames` sends back, so a lost frame is absorbed by the next send
   * however long the quiet stretch in between, and a base is never a frame the
   * session was not sent.
   *
   * The price is a stall when the redundancy runs out. A delta based past the ack
   * presumes the client received the frame it is based on; when `redundancyFrames`
   * sends in a row are lost it did not. The client holds the diff it cannot
   * apply, reports a gap in its next ack, and the server falls back to deltas from
   * the ack until the client has caught up, so the client's view stops for about
   * one round trip. The client's interpolation buffer hides part of that. A change
   * lost with nothing sent after it is found by a timer instead: if the oldest
   * content sent to a session stays unacked for twice its smoothed ack round trip
   * (at least 100 ms, as for a baseline in flight), the server falls back the same
   * way. Pick the smallest value whose stalls your players can live with: 2
   * survives any single lost frame, 3 any two in a row.
   *
   * The server is optimistic only while a session is healthy: it has acked a
   * baseline, none is in flight or needed, no fallback is running and its ack is
   * not overdue. Baselines and resynchronization never run ahead of the ack.
   * Frames that start past the ack carry a marker, and clients report gaps, that
   * clients built before this option do not understand, so deploy clients before
   * enabling it.
   */
  redundancyFrames?: number;
}

/**
 * Default close linger: the client acks every `ackIntervalMs` (33 ms at the
 * default 30 Hz), so one ack interval, a round trip, and a retransmit budget
 * of the unordered channel fit inside 250 ms with room to spare — while
 * keeping the reaping of a session that never acks prompt.
 */
export const DEFAULT_CLOSE_LINGER_MS = 250;

/**
 * A frame the server is waiting on an ack for, a baseline in flight or the newest
 * content of an optimistic session, is presumed lost once it has gone unacked for
 * this many smoothed round trips, and never in less than {@link MIN_ACK_TIMEOUT_MS}.
 */
const ACK_TIMEOUT_ROUND_TRIPS = 2;

/** The shortest time a frame is given before it is presumed lost. */
const MIN_ACK_TIMEOUT_MS = 100;

/**
 * How long a frame is given before it is presumed lost, until the session has a
 * round-trip measurement to scale by: one second, the initial retransmission
 * timeout of RFC 6298. Being a time, not a number of frames, it does not depend on
 * the tick rate or the history window.
 */
const INITIAL_ACK_TIMEOUT_MS = 1000;

/** How often {@link ServerWorld.shutdown} drives `send()` while sessions drain. */
const SHUTDOWN_POLL_MS = 10;

/** Options for {@link ServerWorld.shutdown}. */
export interface ShutdownOptions {
  /**
   * Upper bound, in wall-clock milliseconds, on how long shutdown keeps flushing closing sessions.
   * Sessions still present at the deadline are destroyed without further delivery. Defaults to
   * `closeLingerMs + 1000`.
   */
  timeoutMs?: number;
  /** Recorded on every `NetworkClient.closeReason`. Defaults to `"server shutting down"`. */
  reason?: string;
}

class ServerClientSession {
  public readonly history: History;
  public readonly rpc = new SessionRPC();
  /** Smoothed time between sending a frame and receiving its ack. */
  public readonly rtt: RttEstimator;
  public context!: ServerRPCContext;
  /**
   * Newest frame the client has acknowledged. A new session starts at the
   * frame it was created on, which the client has not acked, so a delta from it
   * is never sent before {@link needsBaseline} clears.
   */
  public ackFrame: number;
  public lastSeenMs = 0;
  /**
   * The client holds no baseline the server can build a delta on: the session
   * is new, or a frame with content that it has not acked has left the history
   * window. A delta is sent only while this is `false`.
   *
   * It clears only when an ack of {@link resyncFrame} or later arrives, which
   * means the client holds that baseline or something newer. One flag is enough
   * because every baseline re-sends the whole view.
   */
  public needsBaseline = true;
  /**
   * `toFrame` of the baseline most recently sent and not yet acknowledged, or
   * `undefined` while none is in flight. While it is set, the server sends the
   * session no state: a delta from a frame the client has not acked would be
   * rejected as a protocol error.
   */
  public resyncFrame: number | undefined = undefined;
  /** `performance.now()` when {@link resyncFrame} was sent. */
  public resyncSentAtMs = 0;
  /**
   * The client has acknowledged a baseline at least once, so it holds replicated
   * state of its own. A baseline sent to such a client goes out even when it is
   * empty, because rebuilding from nothing is what clears the entities the client
   * still holds. Before then an empty baseline is not sent: the client has nothing
   * to clear and nothing to be told.
   */
  public baselineAcked = false;
  /**
   * The last `redundancyFrames` frames in which the session was sent a baseline
   * or a delta with content, as opposed to an empty delta riding along with RPC
   * traffic, or `undefined` while `redundancyFrames` is unset.
   *
   * The client's version is always a frame it was sent, so an optimistic base is
   * the oldest of these, the frame sent `redundancyFrames` sends ago. Every frame
   * after the newest one either sent nothing because its diff was empty, or was
   * withheld while a baseline was in flight, and a delta that starts at an older
   * frame covers both. A base is also never behind the ack, so right after a
   * baseline it is the baseline's frame, and the delta that ends the wait carries
   * everything withheld meanwhile.
   */
  public readonly sent: SentFrames | undefined;
  /**
   * The oldest frame with content sent to the session that the client has not
   * acked, or an older one that has since been acked while nothing newer was
   * sent. Kept with {@link probeSentAtMs} to tell whether the client is catching
   * up: once {@link probeSentAtMs} is older than the ack timeout and the ack has
   * not reached this frame, the session falls back. Only kept while
   * `redundancyFrames` is set.
   */
  public probeFrame: number | undefined = undefined;
  /** `performance.now()` when {@link probeFrame} was sent. */
  public probeSentAtMs = 0;
  /**
   * The frame at which the current fallback began, or `undefined` outside one.
   * While it runs the session is sent deltas from its ack, as without
   * `redundancyFrames`, until the client has caught up. Only kept while
   * `redundancyFrames` is set.
   */
  public fallbackFrame: number | undefined = undefined;
  /**
   * Set by {@link ServerWorld.closeSession}. The session is finished as far as
   * the application is concerned: it stops accepting input and stops
   * replicating, but its RPC outbox still owes the client a reply that
   * explains the close. {@link ServerWorld.send} flushes that reply and then
   * lingers — see {@link ServerClientSession.closeFlushedFrame} — before
   * finishing the teardown.
   */
  public closing = false;
  public closed = false;
  /** Set on the first failed `socket.send`; no further frames are sent. */
  public sendFailed = false;
  /**
   * The frame carrying the replies the close still owes, retransmitted on
   * every linger tick until the client acks it. `undefined` until the flush
   * tick; a closing session with nothing owed never sets it and tears down
   * without a frame.
   */
  public closeFlushedFrame: Server2Client | undefined;
  /**
   * The code and reason {@link ServerWorld.closeSession} was given, delivered
   * to the client on the close frame. `undefined` when the close carried
   * neither, in which case a session with nothing owed closes without a frame.
   */
  public closeNotice: CloseNotice | undefined;
  /** Frame number of {@link closeFlushedFrame}; acking it ends the linger. */
  public closeAckFrame = 0;
  /** Wall-clock deadline in `performance.now()` ms after which the linger ends. */
  public closeDeadlineMs = 0;
  public socket!: VecsSocket;
  public entity!: Entity;

  public constructor(
    lastFrame = -1,
    historyFrames = HISTORY_LENGTH,
    redundancyFrames: number | undefined = undefined
  ) {
    this.ackFrame = lastFrame;
    this.sent =
      redundancyFrames === undefined ? undefined : new SentFrames(redundancyFrames, lastFrame);
    this.history = new History(historyFrames, lastFrame);
    this.rtt = new RttEstimator();
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
  private readonly _closeLingerMs: number;
  private readonly _historyFrames: number;
  private readonly _redundancyFrames: number | undefined;
  private readonly _listeners: VecsSocketListener[] = [];
  private _shutdown: Promise<void> | undefined;
  private _clients!: System<[typeof View, typeof ServerClientSession]>;
  private _frame = 1;

  public constructor(options: ServerWorldOptions = {}) {
    super(options);
    this.name = options.name ?? "main";
    const encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this._encodeBuffer = new Uint8Array(encodeBufferSize);
    this._disconnectGraceMs = options.disconnectGraceMs ?? 10_000;
    this._closeLingerMs = options.closeLingerMs ?? DEFAULT_CLOSE_LINGER_MS;
    this._historyFrames = validateHistoryFrames(options.historyFrames ?? HISTORY_LENGTH);
    this._redundancyFrames =
      options.redundancyFrames === undefined
        ? undefined
        : validateRedundancyFrames(options.redundancyFrames, this._historyFrames);
    this._trackerCache = new TrackerCache(this);
    this._components = this.networkComponents;
    ensureRegistered(this, Networked);
    ensureRegistered(this, NetworkClient);
    ensureRegistered(this, NetworkInput);
    ensureRegistered(this, View);
    ensureRegistered(this, ServerClientSession);
    // No removal is recorded when an entity stops being Networked: it leaves every view, and each
    // view tells its client the entity is gone (see View.exit). A record would only ever reach a
    // view in which the entity is visible again, because it became Networked once more in the same
    // frame, and delete from that client an entity it must keep.
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

  /**
   * The frame the next {@link ServerWorld.send} numbers: the frame a client receives the changes
   * made since the previous send as.
   *
   * During `progress()` it is the frame of the tick in flight, since the world's own send runs
   * after every user phase. A system that stamps state with the frame it holds at, such as a
   * dead-reckoning baseline, reads it here: the client sees that state as of this frame. It starts
   * at 1 and grows by one on every send, whether or not any session is connected.
   */
  public get frame(): number {
    return this._frame;
  }

  /** @internal */
  public _attach(listener: VecsSocketListener): void {
    this._listeners.push(listener);
    listener.on("new", (socket) => this._onNewConnection(socket));
  }

  /**
   * Shut the world's networking down cleanly and resolve once every connection is gone.
   *
   * New connections are refused from the first call. Every session is closed gracefully with
   * {@link ServerWorld.closeSession}, so each client still receives the replies it is owed
   * before its socket closes. Unlike `closeSession`, which relies on the application's next
   * `send()`, shutdown drives {@link ServerWorld.send} itself every few milliseconds until all
   * sessions have been acked or lingered out, or `timeoutMs` passes; sessions left at the deadline
   * are destroyed. Finally the attached listeners' optional `close()` is awaited.
   *
   * Idempotent: later calls return the same promise and ignore their options. Stop the tick loop
   * that drives `progress()` before or while awaiting if you do not want it to share the
   * flushing; running both is harmless.
   *
   * ```ts
   * await world.shutdown({ timeoutMs: 2000 });
   * ```
   */
  public shutdown(options: ShutdownOptions = {}): Promise<void> {
    this._shutdown ??= this._runShutdown(options);
    return this._shutdown;
  }

  private async _runShutdown(options: ShutdownOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this._closeLingerMs + 1000;
    const reason = options.reason ?? "server shutting down";
    const deadline = performance.now() + timeoutMs;
    [...this._sessions.keys()].forEach((id) => this.closeSession(id, reason));
    while (this._sessions.size > 0 && performance.now() < deadline) {
      this.send();
      if (this._sessions.size === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
    [...this._sessions.values()].forEach((session) => session.entity.destroy());
    await Promise.allSettled(this._listeners.map((listener) => listener.close?.()));
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
   * The handler runs once per call. A client re-sends its pending request with
   * every ack, but a copy that arrives while the handler is still running is
   * ignored, and one that arrives after it settled gets the original reply, so
   * a slow or non-idempotent handler is safe.
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
   * further. The next {@link ServerWorld.send} flushes the RPC replies it still
   * owes on a numbered frame and then **lingers**: the socket stays open until
   * the client acks that frame — its delivery receipt — or
   * `closeLingerMs` (250 ms by default) elapses, whichever comes first. A
   * session with nothing owed closes without emitting a frame at all. So
   * `closeSession` returning `true` means the close was scheduled; a peer that
   * acks normally sees its socket close within one ack interval of receiving
   * the reply, and a peer that never acks cannot hold the session open past
   * the linger.
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
   *   Also sent to the client on the close frame, so its `disconnect` event can
   *   say why.
   * @param code - Machine-readable close code, delivered to the client with the
   *   reason. `0`–`100` is reserved for the protocol, as with typed RPC errors;
   *   applications pick their own codes above that range. The reserved code in
   *   use is {@link CLOSE_PROTOCOL_ERROR_CODE} (`1`): this world passes it itself,
   *   with a reason that starts `protocol error:`, when it closes a session
   *   because a frame from it could not be decoded, so do not pass it for any
   *   other reason. A close that carries a reason or a code always sends a close
   *   frame, even when no RPC reply is owed, and lingers until the client acks it
   *   like any other close.
   * @returns `true` when a live session was scheduled to close.
   */
  public closeSession(connection: string | Entity, reason?: string, code?: number): boolean {
    const session = this._sessionFor(connection);
    if (!session) {
      return false;
    }
    if (reason !== undefined) {
      session.entity.getMut(NetworkClient, (client) => {
        client.closeReason = reason;
      });
    }
    if (reason !== undefined || code !== undefined) {
      session.closeNotice = { code, reason };
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
   * A session that has acked a baseline gets a delta from its newest ack. A
   * session without one gets a full baseline (`fromFrame` 0), once: a new
   * session, or one that can no longer be caught up because a frame with
   * content it has not acked has left its
   * {@link ServerWorldOptions.historyFrames | history window}. Until the client
   * acks that baseline the session is sent no state, because a delta from a
   * frame the client does not hold would be rejected; it still receives RPC
   * traffic, and its history still records every frame. A baseline that goes
   * unacked for twice the session's smoothed ack round trip (at least 100 ms,
   * and one second before the first measurement) is presumed lost and sent
   * again, without backing off. A baseline that would be empty is sent only to
   * a client that has acked one before: it holds entities that rebuilding from
   * nothing clears. A session with nothing to send is sent nothing and never
   * needs a baseline for it, however long it stays quiet.
   *
   * With {@link ServerWorldOptions.redundancyFrames} set, a healthy session's delta
   * starts at the optimistic base, `max(ack, base)` where `base` is the frame the
   * session was sent `redundancyFrames` sends ago, instead of at the ack, and the
   * frame carries the optimistic marker when that is past the ack.
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
        // the close still owes the client a frame — and that frame must be
        // allowed to reach the client before the transport goes down.
        this._lingerOrClose(session, nowMs);
        return;
      }

      view._reconcileVisibility();
      view._releaseOldTracker(this._trackerCache);

      const sendsBaseline = this._startsBaseline(session, nowMs);
      if (sendsBaseline) {
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
      const diff = this._stateFor(session, latest, sendsBaseline, nowMs);

      if (!worthAFrame(diff) && rpc.length === 0) {
        return;
      }
      if (diff !== undefined) {
        session.rtt.recordSend(toFrame, nowMs);
        if (worthAFrame(diff)) {
          this._noteContentSent(session, toFrame, nowMs);
        }
      }
      this._sendFrame(
        session,
        new Server2Client({
          diff,
          rpc,
          rpcSettledBelow: session.rpc.settledBelow,
          // A delta that starts past the ack presumes the client holds what is in
          // between; the marker tells the client it may not, and must not fail.
          optimistic: diff !== undefined && diff.fromFrame > session.ackFrame,
        })
      );
    });

    staleSessions.forEach((session) => {
      session.entity.getMut(NetworkClient, (client) => {
        client.closeReason = "disconnect grace period elapsed";
      });
      session.entity.destroy();
    });

    this._updates.clear();
  }

  /**
   * Decide whether this frame sends the session a baseline, and flag the
   * session as needing one if it can no longer be caught up.
   *
   * A session can be served a delta exactly while no frame with content that it
   * has not acked has left the history: a frame that left holding nothing took
   * nothing with it, however old the ack is. The check runs before this frame is
   * pushed, because the baseline decides what the frame holds, so it asks the
   * history about the moment after the push. Needing a baseline is sticky: it
   * clears only when the baseline is acked, in {@link ServerWorld._acknowledge}.
   * But a baseline is sent only when none is in flight, or the one in flight is
   * presumed lost, so a client that is slow to ack is not sent a new baseline
   * every frame.
   */
  private _startsBaseline(session: ServerClientSession, nowMs: number): boolean {
    if (!session.history.canPullAfterPush(session.ackFrame)) {
      session.needsBaseline = true;
    }
    if (!session.needsBaseline) {
      return false;
    }
    return session.resyncFrame === undefined || this._baselinePresumedLost(session, nowMs);
  }

  /**
   * A baseline in flight is presumed lost once twice the session's smoothed ack
   * round trip has passed since it was sent, and at least 100 ms. Before the
   * first round-trip sample there is nothing to scale by, so it is presumed lost
   * after one second, the initial retransmission timeout of RFC 6298. There is
   * no backoff: each time the timeout passes without an ack, the baseline is
   * sent again.
   */
  private _baselinePresumedLost(session: ServerClientSession, nowMs: number): boolean {
    return nowMs - session.resyncSentAtMs > this._ackTimeoutMs(session);
  }

  /**
   * How long a frame may go unacked before the server presumes it lost: twice the
   * session's smoothed ack round trip, at least 100 ms, and one second before the
   * first round-trip sample. It times baselines in flight and, with
   * `redundancyFrames`, the oldest content sent to a session that is still unacked.
   */
  private _ackTimeoutMs(session: ServerClientSession): number {
    const srttMs = session.rtt.srttMs;
    return srttMs === undefined
      ? INITIAL_ACK_TIMEOUT_MS
      : Math.max(ACK_TIMEOUT_ROUND_TRIPS * srttMs, MIN_ACK_TIMEOUT_MS);
  }

  /**
   * The state this frame carries for a session, or `undefined` when it carries
   * none (the frame may still carry RPC traffic).
   *
   * - A baseline is the whole view as of `toFrame`, `fromFrame` 0, and starts
   *   tracking the baseline in flight. Until the client has acked a baseline it
   *   holds nothing, so an empty one is not sent: there is nothing to tell it,
   *   and the server sends nothing for an empty diff. After that the client
   *   holds state, and even an empty baseline goes out, because rebuilding from
   *   nothing is what clears the entities that left its view while it stalled.
   * - While a baseline is in flight, no state at all. Any diff numbered past
   *   the baseline would advance the client's frame without the client holding
   *   the baseline, and the next delta, from the client's ack, would then start
   *   past what the client has.
   * - Otherwise the delta from the newest ack, which the client has by
   *   definition, or, for a healthy session with `redundancyFrames`, from the
   *   optimistic base: see {@link ServerWorld._optimisticBase}.
   */
  private _stateFor(
    session: ServerClientSession,
    latest: StateDiff,
    sendsBaseline: boolean,
    nowMs: number
  ): StateDiff | undefined {
    if (sendsBaseline) {
      if (isEmpty(latest) && !session.baselineAcked) {
        return undefined;
      }
      session.resyncFrame = latest.toFrame;
      session.resyncSentAtMs = nowMs;
      return new StateDiff({
        fromFrame: 0,
        toFrame: latest.toFrame,
        snapshots: latest.snapshots,
        removed: latest.removed,
      });
    }
    if (session.needsBaseline) {
      return undefined;
    }
    const base = this._deltaBase(session, latest.toFrame, nowMs);
    return session.history.pull(base, latest.toFrame);
  }

  /**
   * The frame a delta to `toFrame` starts after: the client's newest ack, or,
   * with `redundancyFrames` and a healthy session, the optimistic base.
   */
  private _deltaBase(session: ServerClientSession, toFrame: number, nowMs: number): number {
    const sent = session.sent;
    if (sent === undefined || !this._isHealthy(session, toFrame, nowMs)) {
      return session.ackFrame;
    }
    return this._optimisticBase(session, sent);
  }

  /**
   * The frame an optimistic delta starts after: `max(ack, sent.oldest)`, where
   * `sent.oldest` is the frame the session was sent `redundancyFrames` sends ago.
   *
   * The client's version is always a frame it was sent, so the base must be one,
   * and a frame number such as `toFrame - redundancyFrames` is not, once traffic
   * is sparse. With sends at frames 100, 101 and 106 and `redundancyFrames` 2, the
   * delta of 106 would start at 104, which was never sent. The newest send at
   * least that old is 101, and a client that lost it is at 100 and would read the
   * delta as a gap. Two sends back is 100, which the client holds unless it lost
   * 101 too. In a busy view every frame is a send and the base is
   * `toFrame - redundancyFrames`.
   *
   * It is at least `redundancyFrames` frames before `toFrame`, so a change travels
   * in `redundancyFrames` consecutive frames, however sparse. Frames after the base
   * that sent nothing, or were withheld while a baseline was in flight, need no
   * special case: the pull merges everything after the base. Never before the ack,
   * so the pull never merges more frames than a plain delta, and right after a
   * baseline it starts at the baseline, which is the ack.
   */
  private _optimisticBase(session: ServerClientSession, sent: SentFrames): number {
    return Math.max(session.ackFrame, sent.oldest);
  }

  /**
   * Whether the session may be sent an optimistic delta this frame.
   *
   * A session is healthy while the client holds a baseline the server can build
   * on, the server is not waiting on one, no fallback is running, and the ack is
   * not overdue. Two things change the state as a side effect, because they are
   * decided by the same facts: a fallback ends once the client has caught up with
   * it, and a session whose ack is overdue starts one, at `toFrame`.
   */
  private _isHealthy(session: ServerClientSession, toFrame: number, nowMs: number): boolean {
    if (!this._holdsBaseline(session) || this._inFallback(session)) {
      return false;
    }
    if (this._ackOverdue(session, nowMs)) {
      session.fallbackFrame = toFrame;
      return false;
    }
    return true;
  }

  /** The client has acked a baseline, and none is in flight or needed. */
  private _holdsBaseline(session: ServerClientSession): boolean {
    return session.baselineAcked && !session.needsBaseline && session.resyncFrame === undefined;
  }

  /**
   * Whether a fallback is running, ending it if the client has caught up.
   *
   * A fallback ends once the ack reaches the frame it began at, or the newest
   * frame with content that was sent: past that the client holds everything there
   * is to hold, and there is nothing to fall back for. Without the second
   * condition a fallback begun in a quiet moment would last until the next change
   * had been sent and acked.
   */
  private _inFallback(session: ServerClientSession): boolean {
    const since = session.fallbackFrame;
    const sent = session.sent;
    if (since === undefined || sent === undefined) {
      return false;
    }
    if (session.ackFrame < Math.min(since, sent.newest)) {
      return true;
    }
    session.fallbackFrame = undefined;
    return false;
  }

  /**
   * Whether the client is not catching up with the content sent to it: the oldest
   * content frame still unacked was sent longer ago than the ack timeout.
   *
   * This is what finds a loss nothing follows. The client detects a lost change
   * from the next frame it receives, but when the change ages out of the
   * redundancy window with nothing else changing, there is no next frame. A gap
   * report the link lost, or a client that is stuck behind a hole, is found the
   * same way.
   */
  private _ackOverdue(session: ServerClientSession, nowMs: number): boolean {
    const probe = session.probeFrame;
    return (
      probe !== undefined &&
      session.ackFrame < probe &&
      nowMs - session.probeSentAtMs > this._ackTimeoutMs(session)
    );
  }

  /**
   * Record that a baseline or a delta with content went out in `frame`: it joins
   * the frames an optimistic base is taken from, and, unless an older one is still
   * waiting, it is the one the liveness timer watches.
   */
  private _noteContentSent(session: ServerClientSession, frame: number, nowMs: number): void {
    const sent = session.sent;
    if (sent === undefined) {
      return;
    }
    sent.push(frame);
    if (session.probeFrame === undefined || session.ackFrame >= session.probeFrame) {
      session.probeFrame = frame;
      session.probeSentAtMs = nowMs;
    }
  }

  private _onNewConnection(socket: VecsSocket): void {
    if (this._shutdown) {
      socket.close();
      return;
    }
    const entity = this.entity().add(Networked).add(NetworkClient).add(View);
    const session = new ServerClientSession(
      this._frame - 1,
      this._historyFrames,
      this._redundancyFrames
    );
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

  /**
   * The only place the server calls `socket.send`. A transport can fail a send
   * because the peer is already gone, either by throwing or, for an async
   * transport, by returning a promise that rejects. Neither may escape: an
   * unhandled rejection is fatal to the whole process. A failed send is treated
   * as that session's transport `disconnect`, so it takes the same teardown path
   * and runs it once however many sends fail. Works with a `send` that returns
   * nothing as well as one that returns a promise.
   */
  private _sendFrame(session: ServerClientSession, message: Server2Client): void {
    if (session.closed || session.sendFailed) {
      return;
    }
    const fail = (): void => {
      if (session.sendFailed) {
        return;
      }
      session.sendFailed = true;
      this._onDisconnect(session.context.connectionId);
    };
    try {
      const result: unknown = session.socket.send(this._encode(message));
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        (result as PromiseLike<unknown>).then(undefined, fail);
      }
    } catch {
      fail();
    }
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
    // drops everything but the ack: it has stopped accepting work, and the
    // only thing still owed is the reply `send` flushed — acking that frame is
    // how the client confirms delivery and ends the close linger early.
    if (session.closed) {
      return;
    }
    let message: Client2Server;
    try {
      message = new Decoder(data).read(Client2Server);
    } catch (error) {
      // A frame that cannot be decoded — truncated or random bytes, or a field tag
      // from a newer protocol version — must not throw into the transport: nothing
      // above the socket's `receive` listener catches it (`@vworlds/dgram-server`
      // re-emits each data-channel message unguarded), so it would surface as an
      // uncaught exception in the server process. It is that session's protocol
      // violation instead: the frame is dropped and only this session is closed,
      // gracefully, through `closeSession`. A session that is already closing
      // keeps the reason it was given.
      if (!session.closing) {
        const detail = error instanceof Error ? error.message : String(error);
        this.closeSession(session.entity, `protocol error: ${detail}`, CLOSE_PROTOCOL_ERROR_CODE);
      }
      return;
    }
    if (session.closing) {
      if (message.ackFrame <= session.history.lastFrame) {
        session.ackFrame = Math.max(session.ackFrame, message.ackFrame);
      }
      return;
    }
    const nowMs = performance.now();
    session.lastSeenMs = nowMs;
    if (message.ackFrame <= session.history.lastFrame) {
      this._acknowledge(session, message.ackFrame, nowMs);
    }
    if (message.gap) {
      this._onGapReported(session);
    }
    if (message.input !== undefined) {
      session.entity.set(NetworkInput, { input: message.input });
    }
    // On every frame, not only those that carry requests: the frame that reports
    // a call as settled may have no request to send.
    session.rpc.setPeerSettledBelow(message.rpcSettledBelow);
    if (message.rpc.length > 0) {
      session.rpc.process(message.rpc);
    }
  }

  /**
   * Record the client's ack: move its acked frame forward, take a round-trip
   * sample from it, and, if it covers the baseline in flight, mark the baseline
   * delivered.
   *
   * An ack of the baseline's frame or any later one means the client holds that
   * baseline or something newer, so deltas can resume from the ack. An ack older
   * than the baseline, such as the client's initial 0, proves nothing about it
   * and changes nothing.
   */
  private _acknowledge(session: ServerClientSession, ackFrame: number, nowMs: number): void {
    if (ackFrame > session.ackFrame) {
      session.ackFrame = ackFrame;
      session.rtt.recordAck(ackFrame, nowMs);
    }
    if (session.resyncFrame !== undefined && session.ackFrame >= session.resyncFrame) {
      session.needsBaseline = false;
      session.baselineAcked = true;
      session.resyncFrame = undefined;
    }
  }

  /**
   * The client reported a gap: it holds an optimistic delta whose base it never
   * received. Fall back to deltas from the ack, which it has by definition, from
   * the next frame until the client has caught up.
   *
   * Ignored while a fallback already runs, since its deltas are on the way. A
   * report that arrives while a baseline is in flight, from a client that is about
   * to reset on it, starts a fallback that the baseline's ack ends at once, the
   * baseline being the newest frame sent.
   */
  private _onGapReported(session: ServerClientSession): void {
    if (this._redundancyFrames === undefined || this._inFallback(session)) {
      return;
    }
    session.fallbackFrame = this._frame;
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
   * Advance one closing session towards its teardown, flushing the replies it
   * still owes and then lingering before the transport goes down.
   *
   * A closing session with nothing owed and no close notice destroys immediately, exactly as
   * before: nothing is left to deliver, so the close is prompt. Otherwise the
   * owed replies are written on a numbered frame — an empty
   * `StateDiff` from the client's last acknowledged frame — so the client's
   * next ack is a delivery receipt for the very datagram that carries them.
   * The transport is an unreliable channel: closing the socket in the same
   * turn as the flush would discard the queued or in-flight frame, and the
   * client would lose the typed error that explains the close.
   *
   * After the flush the session lingers, bounded by
   * {@link ServerWorldOptions.closeLingerMs}:
   *
   * - the client's ack of the flush frame ends the linger immediately;
   * - a transport `disconnect` — including a failed flush send, which
   *   {@link ServerWorld._sendFrame} routes there — tears the session down at
   *   once through the normal exactly-once path;
   * - the deadline is the bound for a client that never acks.
   *
   * While the linger runs the flush frame is retransmitted on every call (the
   * client deduplicates), and any reply that finished after the flush tick
   * joins the retransmitted frame, so everything the session owes travels on
   * the receipt frame. No state is replicated and no new call is accepted
   * while closing — only the ack is honored.
   *
   * @param session - The closing session, visited by {@link ServerWorld.send}.
   * @param nowMs - Wall-clock timestamp (`performance.now()`) of this send.
   */
  private _lingerOrClose(session: ServerClientSession, nowMs: number): void {
    const flushed = session.closeFlushedFrame;
    if (flushed !== undefined) {
      if (session.ackFrame >= session.closeAckFrame || nowMs >= session.closeDeadlineMs) {
        // Destroying the entity lands in the `ServerClientSession` remove hook,
        // which is what removes the session and closes the socket.
        session.entity.destroy();
        return;
      }
      const late = session.rpc.getOutgoing();
      if (late.length > 0) {
        flushed.rpc.push(...late);
      }
      this._sendFrame(session, flushed);
      return;
    }
    const rpc = session.rpc.getOutgoing();
    if (rpc.length === 0 && session.closeNotice === undefined) {
      session.entity.destroy();
      return;
    }
    // The receipt frame is a numbered frame the client's existing ack covers:
    // an empty diff is applied as a no-op, and its frame number is what the
    // client acks back. `fromFrame` starts at the client's last acked frame
    // (never 0, which would read as a full baseline) so the push is always in
    // range for the client's diff buffer.
    const toFrame = session.history.lastFrame + 1;
    session.history.push(new StateDiff({ fromFrame: toFrame - 1, toFrame }));
    const frame = new Server2Client({
      diff: new StateDiff({ fromFrame: Math.max(session.ackFrame, 1), toFrame }),
      rpc,
      rpcSettledBelow: session.rpc.settledBelow,
      close: session.closeNotice,
    });
    session.closeFlushedFrame = frame;
    session.closeAckFrame = toFrame;
    session.closeDeadlineMs = nowMs + this._closeLingerMs;
    this._sendFrame(session, frame);
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
    // never issues calls of its own, so this only drops what the session owed the
    // client: its cached and queued replies, and the replies of handlers still running.
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

function isEmpty(diff: StateDiff): boolean {
  return diff.snapshots.length === 0 && diff.removed.length === 0;
}

/**
 * Whether a diff earns a frame of its own: it has content, or it is a baseline,
 * which resets the client even when it is empty. An empty delta does not, and
 * rides along only when the frame carries RPC traffic anyway.
 */
function worthAFrame(diff: StateDiff | undefined): boolean {
  return diff !== undefined && (diff.fromFrame === 0 || !isEmpty(diff));
}
