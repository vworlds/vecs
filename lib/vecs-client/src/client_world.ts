import {
  Client2Server,
  RPC,
  RPC_CLOSED_CODE,
  RPC_RESPONSE_ID,
  RPCError,
  Server2Client,
  SessionRPC,
  StateDiff,
  ALL_COMPONENTS,
  cid_unpack,
  decodeRelationshipSnapshot,
  NetworkWorld,
  type NetworkWorldOptions,
  type RPCHandler,
  type VecsSocket,
  worldPath,
} from "@vworlds/vecs-protocol";
import {
  type ComponentInstance,
  type ComponentClass,
  type EID,
  type Entity,
  Events,
  Exclusive,
  Query,
  ON_LOAD,
  Relationship,
} from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import {
  ComponentSnapshot,
  DiffBuffer,
  diffFromStateDiff,
  type ComponentInterpolator,
} from "./diff_buffer.js";

class Networked {}

const DEFAULT_CLIENT_LOCAL_ENTITY_ID_START = 10000;

export interface ClientWorldResetEvent {
  initial: boolean;
  fromFrame: number;
  toFrame: number;
}

export type ClientWorldResetHandler = (event: ClientWorldResetEvent) => void;

export interface ClientWorldEvents {
  disconnect: () => void;
  reset: ClientWorldResetHandler;
}

export interface ClientWorldOptions extends NetworkWorldOptions {
  /**
   * Transport to attach at construction, equivalent to calling
   * {@link ClientWorld.attachSocket}. It must already be connected: an ack sent
   * before the transport is ready is a failed send, which disconnects the world.
   */
  socket?: VecsSocket;
  encodeBufferSize?: number;
  interpolatorBucketLength?: number;
  serverTickIntervalMs?: number;
  ackIntervalMs?: number;
  /**
   * Component types to interpolate between server frames, keyed by component
   * class, with the function used to blend each one. Types without an entry
   * are snapped to their latest received value. No interpolators are registered
   * by default; pass an entry to opt in (e.g. wiring `interpolatePosition` to
   * your position-like component class). Each class must be a registered
   * network component; an unregistered class throws at construction time.
   */
  interpolators?: Array<readonly [ComponentClass, ComponentInterpolator]>;
}

export interface DgramConnectOptions extends Omit<ClientWorldOptions, "socket"> {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  apiBasePath?: string;
  rtcConfig?: RTCConfiguration;
}

/**
 * The browser-side replica of a {@link ServerWorld}.
 *
 * A `ClientWorld` is scoped to one connection: connect it, drive it from
 * `progress()`, and tear it down with {@link ClientWorld.dispose} when the player
 * moves to another world. A fresh world per connection is what keeps listeners,
 * timers, and replicated entities from outliving a switch.
 */
export class ClientWorld extends NetworkWorld {
  public readonly events = new Events<ClientWorldEvents>();
  private _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  private readonly _rpcInbox: RPC[] = [];
  private readonly _diffBuffer: DiffBuffer;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _ackIntervalMs: number;
  private readonly _networkedQuery: InstanceType<typeof Query>;
  private readonly _relationshipTargetEids = new WeakMap<ComponentInstance, readonly EID[]>();
  private _input: unknown;
  private _ackTimer: ReturnType<typeof setInterval> | undefined;
  private _baselineApplied = false;
  private _disconnected = false;
  private _forceBaselineReset = false;
  private _disposed = false;

  public constructor(options: ClientWorldOptions = {}) {
    const localEntityIdStart = options.localEntityIdStart ?? DEFAULT_CLIENT_LOCAL_ENTITY_ID_START;
    super({
      ...options,
      localEntityIdStart,
      networkEntityReuseWaitFrames: 0,
    });
    this._encodeBuffer = new Uint8Array(options.encodeBufferSize ?? 64 * 1024);
    this._ackIntervalMs = options.ackIntervalMs ?? 1000 / 30;
    this.component(Networked);
    this._networkedQuery = this.query("ClientWorld:Networked").with(Networked).track().build();
    this._diffBuffer = new DiffBuffer(
      options.interpolatorBucketLength ?? 3,
      options.serverTickIntervalMs ?? 1000 / 30,
      (snapshot) => this.decodeComponentSnapshot(snapshot),
      options.interpolators?.map(([Class, interpolator]) => {
        const registered = this.networkComponents.find((r) => r.Class === Class);
        if (!registered) {
          throw new Error(
            `interpolators: ${Class.name ?? "component"} is not a registered network component`
          );
        }
        return [registered.wireType, interpolator] as const;
      }) ?? []
    );
    this.system("ClientWorld:Apply")
      .phase(ON_LOAD)
      .run((now) => this.apply(now));

    if (options.socket) {
      this.attachSocket(options.socket);
    }
  }

  /**
   * Connect to a `VecsListener`-hosted world over the dgram transport.
   *
   * @param options - Connection settings; `host`, `port`, and `worldName` select
   *   the world, and the remaining fields are passed to the constructor.
   * @returns A world with its socket already attached and connected. The socket
   *   is attached only after `connect()` resolves, so no ack is sent before the
   *   data channel exists.
   * @throws Whatever `connect()` rejects with, after disposing the unattached
   *   world and closing the socket.
   */
  public static async connectDgram(options: DgramConnectOptions): Promise<ClientWorld> {
    const { ClientSocket } = (await import("@vworlds/dgram-client")) as unknown as {
      ClientSocket: new (
        url: string,
        config: RTCConfiguration
      ) => VecsSocket & { connect(): Promise<void> };
    };
    const basePath = worldPath(options.apiBasePath, options.worldName);
    const socket = new ClientSocket(
      `${options.protocol ?? "http"}://${options.host}:${options.port}${basePath}`,
      options.rtcConfig ?? {}
    );
    const client = new ClientWorld(options);
    try {
      await socket.connect();
    } catch (error) {
      // Nothing was attached, so only the transport and the world need releasing.
      client.dispose();
      socket.close();
      throw error;
    }
    client.attachSocket(socket);
    return client;
  }

  /**
   * Bind this world to a transport socket and start the ack timer.
   *
   * The socket must already be **connected**: the ack timer sends immediately
   * on its first tick, and a send the transport rejects (for example dgram's
   * `DATA_CHANNEL_NOT_CREATED` before the channel opens) is treated as a
   * disconnect. Await the transport's `connect()` first, as
   * {@link ClientWorld.connectDgram} does. The same applies to
   * {@link ClientWorldOptions.socket}.
   *
   * `VecsSocket` has no `off`, so the `receive` and `disconnect` handlers stay
   * attached for the socket's lifetime; {@link ClientWorld.dispose} makes them
   * no-ops instead.
   *
   * Attaching a socket after a disconnect is the reconnect path: it clears the
   * disconnected state, so {@link ClientWorld.invoke} accepts calls again. Late
   * events from the previous socket are ignored. Calls made while disconnected
   * were already rejected and are not replayed on the new socket.
   *
   * @param socket - Transport to receive frames from. Passing a second socket
   *   replaces the first without detaching it — dispose the world instead.
   * @throws If the world has already been disposed.
   */
  public attachSocket(socket: VecsSocket): void {
    if (this._disposed) {
      throw new Error("ClientWorld is disposed");
    }
    this._socket = socket;
    this._disconnected = false;
    socket.on("receive", (data) => this._receive(data));
    socket.on("disconnect", () => this._handleDisconnect(socket));
    this._startAckTimer();
  }

  /** Set the input payload sent with every ack until it is replaced. */
  public setInput(input: unknown): void {
    this._input = input;
  }

  /**
   * Call the server and resolve with its reply parameters.
   *
   * Rejects with an `RPCError` carrying the server's code and message, or with
   * code `RPC_CLOSED_CODE` when the call cannot reach, or can no longer be
   * answered by, its peer: the world is disposed, the attached socket has been
   * lost (disconnect event, failed send or {@link ClientWorld.close}) and no
   * replacement is attached yet, or an already-pending call loses its peer. A
   * call made while disconnected is rejected immediately and never queued, so it
   * cannot be sent on a later connection — which may be a different server
   * world. A reply that was already received when the connection was lost still
   * settles its call with the server's result or error, rather than
   * `RPC_CLOSED_CODE`, even if {@link ClientWorld.apply} has not run yet. A client call is never abandoned silently, because `ClientWorld`
   * does not run `SessionRPC.timeoutTick`.
   *
   * A call made before the first {@link ClientWorld.attachSocket} is queued and
   * sent once a socket is attached.
   *
   * @param rpcId - Request id to call.
   * @param params - Positional parameters to send.
   */
  public invoke(rpcId: number, params: unknown[] = []): Promise<unknown[]> {
    if (this._disposed) {
      return Promise.reject(
        new RPCError(RPC_CLOSED_CODE, "ClientWorld disposed before the RPC completed")
      );
    }
    if (this._disconnected) {
      return Promise.reject(new RPCError(RPC_CLOSED_CODE, "ClientWorld disconnected"));
    }
    return this._rpc.invoke(rpcId, params).then((response) => response.params);
  }

  /**
   * Register the handler for an RPC the server calls on this client.
   *
   * A client has a single peer, so the handler's caller context is `undefined`.
   *
   * @param rpcId - Request id to answer.
   * @param handler - Handler run for each incoming call; see {@link RPCHandler}.
   */
  public listen(rpcId: number, handler: RPCHandler): void {
    this._rpc.listen(rpcId, handler);
  }

  /**
   * Apply buffered server frames as of `now`: run queued RPC handlers, then
   * interpolate or snap replicated components into the world.
   *
   * Registered as the world's own `Apply` system in the `ON_LOAD` phase, so
   * `progress()` drives it; call it directly only for a world with no tick loop.
   *
   * @param now - Timestamp in milliseconds to interpolate towards.
   */
  public apply(now: number): void {
    if (this._rpcInbox.length > 0) {
      const incoming = this._rpcInbox.splice(0);
      this._rpc.process(incoming);
    }
    const diff = this._diffBuffer.pull(now);
    diff.snapshots.forEach((snapshot) => this._applySnapshot(snapshot));
    (diff.removed as number[] | undefined)?.forEach((key) => {
      const [eid, wireType] = cid_unpack(key);
      this._removeComponent(eid, wireType);
    });
  }

  /**
   * Ack the latest applied frame to the server, with the current input and any queued RPCs.
   *
   * A synchronous transport error or rejected transport promise closes the client connection,
   * so the ack timer cannot leave an unhandled rejection after a peer disappears.
   */
  public send(): void {
    const socket = this._socket;
    if (!socket || this._disposed || this._disconnected) {
      return;
    }
    const rpc = this._rpc.getOutgoing();
    const ackFrame = this._diffBuffer.version < 0 ? 0 : this._diffBuffer.version;
    const encoder = new Encoder(this._encodeBuffer);
    encoder.write(new Client2Server({ ackFrame, input: this._input, rpc }));
    try {
      const sent = socket.send(encoder.getBuffer()) as unknown;
      if (sent && typeof (sent as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(sent).catch(() => this._handleDisconnect(socket));
      }
    } catch {
      this._handleDisconnect(socket);
    }
  }

  /**
   * Drop the transport and stop the ack timer, leaving the world intact.
   *
   * Use this for a disconnect the client may reconnect from: replicated entities
   * stay in place, and a later baseline re-creates them. Pending RPCs reject with
   * `RPC_CLOSED_CODE`, because the peer can no longer answer them, and so do
   * {@link ClientWorld.invoke} calls made until a new socket is attached. A reply
   * already received but not yet applied settles its call first, and queued
   * server-to-client requests are dropped unrun. Use
   * {@link ClientWorld.dispose} to release everything.
   */
  public close(): void {
    this._stopAckTimer();
    const socket = this._socket;
    if (socket) {
      this._handleDisconnect(socket);
      socket.close();
    }
  }

  /**
   * Tear the world down for good, so a fresh `ClientWorld` can take over the page.
   *
   * In order: pending {@link ClientWorld.invoke} calls reject with an
   * `RPCError` carrying code `RPC_CLOSED_CODE` (replies still queued unapplied
   * are abandoned with everything else, unlike {@link ClientWorld.close}); the ack timer stops; replicated
   * entities are destroyed — firing every exit system, which is what lets render
   * hooks free their resources; and the socket closes.
   *
   * Idempotent, and safe to call on a world that never connected. `VecsSocket`
   * has no `off`, so after dispose the `receive` and `disconnect` handlers are
   * left attached but do nothing: a late frame cannot revive the world, and
   * dispose's own `disconnect` is not re-emitted. Reconnecting or re-attaching
   * a socket to a disposed world throws — build a new `ClientWorld` instead.
   */
  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._rpc.abortPending(
      new RPCError(RPC_CLOSED_CODE, "ClientWorld disposed before the RPC completed")
    );
    this._rpcInbox.length = 0;
    this._destroyNetworkEntities();
    this._diffBuffer.reset();
    this.close();
  }

  private _receive(data: Uint8Array): void {
    if (this._disposed) {
      return;
    }
    const message = new Decoder(data).read(Server2Client);
    if (message.rpc.length > 0) {
      this._rpcInbox.push(...message.rpc);
    }
    if (message.diff) {
      this._pushDiff(message.diff);
    }
  }

  private _pushDiff(sd: StateDiff): void {
    // A diff with fromFrame === 0 is a full baseline: the complete authoritative
    // state at sd.toFrame. The server streams these whenever a client falls
    // outside its history window -- most commonly a backgrounded tab, where the
    // render loop (and therefore DiffBuffer.pull) is suspended and acks are
    // throttled, so the server keeps resending the whole world until the client
    // catches up.
    //
    // A baseline is reset-then-rebuild: every server-owned entity is destroyed
    // and then recreated from the snapshot. Destroying first is what makes the
    // rebuild fire each entity's `enter` again, so view systems that attach
    // client-side state on enter (e.g. spacerocks' Drawable draw statements)
    // rebuild it. Reconciling in place instead would re-`attach` onto the living
    // entity, which fires `modified` -- not `enter` -- leaving that client-side
    // state stale or empty. The teardown runs here, at receive time (synchronous,
    // outside the deferred apply queue), so the entities are fully gone before
    // the next apply replays the baseline and recreates them.
    if (sd.fromFrame === 0) {
      // Skip baselines we have already advanced past (duplicates or, with the
      // unordered transport, stragglers). After a reconnect the server may have
      // restarted its frame counter, so a forced reset overrides this.
      if (!this._forceBaselineReset && sd.toFrame <= this._diffBuffer.version) {
        return;
      }
      this._forceBaselineReset = false;
      const initial = !this._baselineApplied;
      this._baselineApplied = true;
      this._destroyNetworkEntities();
      this._diffBuffer.reset();
      this._diffBuffer.push(diffFromStateDiff(sd));
      this.events.emit("reset", { initial, fromFrame: sd.fromFrame, toFrame: sd.toFrame });
      return;
    }
    this._diffBuffer.push(diffFromStateDiff(sd));
  }

  /**
   * Decode one component snapshot into a component instance.
   *
   * Relationships decode to the component plus their target EIDs, which
   * {@link ClientWorld._applyRelationshipSnapshot} resolves to local entities.
   * The decoded instance replaces the snapshot's payload so a frame applied
   * twice does not decode twice.
   *
   * @param snapshot - Snapshot from the diff buffer.
   * @returns The decoded component instance.
   * @throws If the snapshot names a wire type this world did not register.
   */
  public decodeComponentSnapshot(snapshot: ComponentSnapshot): ComponentInstance {
    if (!(snapshot.payload instanceof Uint8Array)) {
      return snapshot.payload;
    }
    const registered = this.getNetworkComponent(snapshot.wireType);
    if (!registered) {
      throw new Error(
        `Received snapshot for unregistered component wire type ${snapshot.wireType}`
      );
    }
    const decoder = new Decoder(snapshot.payload);
    if (registered.Class.prototype instanceof Relationship) {
      const decoded = decodeRelationshipSnapshot(decoder, registered.Class);
      if (decoded.targetEids.length > 1 && this.entity(registered.Class).has(Exclusive)) {
        throw new Error(
          `Exclusive relationship ${registered.Class.name} snapshot has ${decoded.targetEids.length} targets`
        );
      }
      this._relationshipTargetEids.set(decoded.component, decoded.targetEids);
      return (snapshot.payload = decoded.component);
    }
    return (snapshot.payload = decoder.read(registered.Class) as ComponentInstance);
  }

  private _applySnapshot(snapshot: ComponentSnapshot): void {
    const component = this.decodeComponentSnapshot(snapshot);
    const entity = this.getOrCreateEntity(snapshot.eid, (e) => e.add(Networked));

    if (component instanceof Relationship) {
      this._applyRelationshipSnapshot(entity, component);
      return;
    }

    entity.attach(component as object);
  }

  private _applyRelationshipSnapshot(entity: Entity, component: Relationship): void {
    const relClass = component.constructor as ComponentClass<Relationship>;
    const targetEids = this._relationshipTargetEids.get(component);
    if (targetEids === undefined) {
      throw new Error(`Missing decoded targets for relationship ${relClass.name}`);
    }

    const targets = targetEids.map((eid) =>
      this.getOrCreateEntity(eid, (target) => target.add(Networked))
    );
    // targets() already returns a snapshot, so it stays stable while edges change below.
    const currentTargets = entity.targets(relClass);
    const previousTargets = new Set(currentTargets);
    targets.forEach((target) => {
      if (!previousTargets.has(target)) {
        entity.add(relClass, target);
      }
    });
    const nextTargets = new Set(targets);
    currentTargets.forEach((target) => {
      if (!nextTargets.has(target)) {
        entity.remove(relClass, target);
      }
    });
    // The decoder rejects zero-target snapshots, so the relationship is attached here.
    entity.set(relClass, component);
  }

  private _removeComponent(eid: EID, wireType: number): void {
    // Merged/interpolated client diffs can contain a net removal for an entity
    // whose create snapshot was compressed away before it materialized locally.
    const entity = this.getEntity(eid);
    if (!entity) {
      return;
    }
    if (wireType === ALL_COMPONENTS) {
      entity.destroy();
      return;
    }
    const registered = this.getNetworkComponent(wireType);
    if (registered && entity.get(registered.Class)) {
      entity.remove(registered.Class);
    }
  }

  // Destroy every network entity so an incoming baseline can recreate them
  // from scratch (re-firing each entity's `enter`), and so `dispose()` releases
  // them. query.forEach wraps in beginDefer/endDefer, so destroying inside the
  // callback is safe.
  private _destroyNetworkEntities(): void {
    this._networkedQuery.forEach((entity) => entity.destroy());
  }

  private _handleDisconnect(socket: VecsSocket | undefined): void {
    if (this._disposed || this._disconnected || socket !== this._socket) {
      return;
    }
    this._disconnected = true;
    this._stopAckTimer();
    // Replies already received but not yet applied still answer their calls, so
    // settle them first. Queued server requests are dropped: a dead connection
    // cannot carry their replies, and they must never run on a later one.
    const queued = this._rpcInbox.splice(0);
    this._rpc.process(queued.filter((message) => message.rpcId === RPC_RESPONSE_ID));
    this._rpc.abortPending(
      new RPCError(RPC_CLOSED_CODE, "ClientWorld disconnected before the RPC completed")
    );
    // A reconnect may land on a server whose frame counter restarted, so the
    // next baseline can carry a lower frame than the one we last saw. Force the
    // next baseline to be adopted regardless of its frame number.
    if (this._baselineApplied) {
      this._forceBaselineReset = true;
    }
    this.events.emit("disconnect");
  }

  private _startAckTimer(): void {
    if (this._ackTimer !== undefined) {
      return;
    }
    this._ackTimer = setInterval(() => this.send(), this._ackIntervalMs);
    (this._ackTimer as { unref?: () => void }).unref?.();
  }

  private _stopAckTimer(): void {
    if (this._ackTimer === undefined) {
      return;
    }
    clearInterval(this._ackTimer);
    this._ackTimer = undefined;
  }
}
