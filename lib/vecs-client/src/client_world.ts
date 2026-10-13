import {
  CLOSE_PROTOCOL_ERROR_CODE,
  Client2Server,
  RPC,
  RPC_CLOSED_CODE,
  RPC_RESPONSE_ID,
  RPCError,
  Server2Client,
  SessionRPC,
  StateDiff,
  type CloseNotice,
  cid_pack,
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
  With,
} from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import {
  ComponentSnapshot,
  DiffBuffer,
  diffFromStateDiff,
  type ComponentInterpolator,
  type Diff,
} from "./diff_buffer.js";

class Networked {}

const DEFAULT_CLIENT_LOCAL_ENTITY_ID_START = 10000;

export interface ClientWorldResetEvent {
  initial: boolean;
  fromFrame: number;
  toFrame: number;
}

export type ClientWorldResetHandler = (event: ClientWorldResetEvent) => void;

/**
 * Payload of the `disconnect` event when the connection was closed with an
 * explanation. It is one of two notices, both shaped like the server's
 * `closeSession(connection, reason, code)` arguments:
 *
 * - the server's own notice, when it closed the session on purpose and the close
 *   frame arrived;
 * - this client's protocol-error notice, `{ code: CLOSE_PROTOCOL_ERROR_CODE,
 *   reason: "protocol error: ..." }`, when the client could not decode or accept
 *   what the server sent — a frame, a component snapshot inside one, or a diff
 *   that starts after the last frame the client acknowledged and is not marked
 *   optimistic — and closed the connection itself. The reason ends with the
 *   message of the error that caused the close.
 *
 * See {@link CLOSE_PROTOCOL_ERROR_CODE}.
 */
export type ClientWorldDisconnectEvent = CloseNotice;

export interface ClientWorldEvents {
  /**
   * The connection is gone. The payload is present only when a notice explains
   * why — the server closed the connection deliberately and its notice arrived,
   * or this client closed it because it could not decode or accept what the server
   * sent (code {@link CLOSE_PROTOCOL_ERROR_CODE}); see {@link ClientWorldDisconnectEvent}.
   * For transport loss, a failed send, or a local `close()` / `dispose()` the
   * handler receives `undefined`.
   */
  disconnect: (event?: ClientWorldDisconnectEvent) => void;
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
 * timers, and entities, replicated or local, from outliving a switch.
 */
export class ClientWorld extends NetworkWorld {
  public readonly events = new Events<ClientWorldEvents>();
  private _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  // Server-to-client requests waiting for apply() to run their handlers. Replies never wait here.
  private readonly _rpcInbox: RPC[] = [];
  private readonly _diffBuffer: DiffBuffer;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _ackIntervalMs: number;
  private readonly _networkedQuery: InstanceType<typeof Query>;
  private readonly _relationshipTargetEids = new WeakMap<ComponentInstance, readonly EID[]>();
  private _input: unknown;
  // The diff `_pull` took from the buffer, which `_applyPulled` has yet to apply.
  private _pulled: Diff | undefined;
  private _withRemovalKeys: Set<number> | undefined;
  private _ackTimer: ReturnType<typeof setInterval> | undefined;
  private _baselineApplied = false;
  private _closeNotice: CloseNotice | undefined;
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
    // Applying a diff takes two systems, because the world must be able to destroy an entity and
    // then create another under the same eid, and inside a system a destroy is only queued: it
    // takes effect at the flush after the system, and until then `getOrCreateEntity(eid)` still
    // returns the entity being destroyed. The first system pulls the diff and destroys the
    // entities it removes; the flush that follows it completes the destruction and frees the
    // eids; the second applies the snapshots and the component removals. Both run in ON_LOAD, in
    // this order, before any system a game adds to the phase.
    this.system("ClientWorld:Pull")
      .phase(ON_LOAD)
      .run((now) => this._pull(now));
    this.system("ClientWorld:Apply")
      .phase(ON_LOAD)
      .run(() => this._applyPulled());

    if (options.socket) {
      this.attachSocket(options.socket);
    }
  }

  /**
   * The server frame this world renders, fractional while it interpolates between two frames.
   *
   * It is the point on the server's timeline that the interpolators sample, and it is kept
   * whether or not any are registered. While the world blends from the last frame applied, N,
   * toward the next frame buffered, M, with blend factor `alpha`, it is `N + (M - N) * alpha`:
   * `N + alpha` in steady play, where M is N + 1. Use it to put state the client computes
   * itself on the same timeline, such as a pose extrapolated from a baseline taken at a known
   * server frame, so that extrapolated and interpolated entities show the same moment.
   *
   * - It is `0` until the first baseline is applied. A baseline that resets the world, on
   *   connect, on reconnect or after a stall, sets it back to `0` as it destroys the replicated
   *   entities, and the `apply()` that rebuilds them moves it to the baseline's frame. After a
   *   reconnect that frame can be lower than before, because the new server's frame counter can
   *   start over. {@link ClientWorld.dispose} sets it back to `0` too.
   * - Otherwise it changes only in {@link ClientWorld.apply}, which `progress()` runs, and it
   *   never decreases, as long as `now` never decreases.
   * - It never runs past the newest frame received. It does not pass the frame it blends toward,
   *   and when the buffer runs dry it holds at the newest frame applied until more arrive. It
   *   does not extrapolate: looking past the newest frame is up to the caller.
   */
  public get renderFrame(): number {
    return this._diffBuffer.renderFrame;
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
   * no-ops instead, and so does attaching another socket: each handler checks
   * that its own socket is still the attached one.
   *
   * Attaching a socket after a disconnect is the reconnect path: it clears the
   * disconnected state, so {@link ClientWorld.invoke} accepts calls again. Late
   * events from the previous socket, received frames included, are ignored. Calls
   * made while disconnected were already rejected and are not replayed on the new
   * socket.
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
    this._closeNotice = undefined;
    socket.on("receive", (data) => this._receive(socket, data));
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
   * The call settles as soon as its reply arrives, whether or not anything
   * applies the world: it does not wait for {@link ClientWorld.apply} or
   * `progress()`. Its request is sent with every ack until then and never
   * again afterwards. State the server sent in the same frame is applied later,
   * by {@link ClientWorld.apply} and possibly after interpolation delay, so do
   * not assume the reply's side effects are visible in the world when the
   * promise resolves.
   *
   * Rejects with an `RPCError` carrying the server's code and message, or with
   * code `RPC_CLOSED_CODE` when the call cannot reach, or can no longer be
   * answered by, its peer: the world is disposed, the attached socket has been
   * lost (disconnect event, failed send or {@link ClientWorld.close}) and no
   * replacement is attached yet, or an already-pending call loses its peer. A
   * call made while disconnected is rejected immediately and never queued, so it
   * cannot be sent on a later connection — which may be a different server
   * world. A call whose reply has arrived has already settled with the server's
   * result or error, so a later disconnect or disposal cannot turn it into
   * `RPC_CLOSED_CODE`. A client call is never abandoned silently, because
   * `ClientWorld` does not run `SessionRPC.timeoutTick`.
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
   * The handler runs from {@link ClientWorld.apply}, not when the request
   * arrives, so under `progress()` it runs in the world's `ON_LOAD` phase. It
   * runs once per call, however many copies of the request the server sends.
   * Its answer is queued once the handler settles and goes out with the next
   * ack.
   *
   * @param rpcId - Request id to answer.
   * @param handler - Handler run once for each incoming call; see {@link RPCHandler}.
   */
  public listen(rpcId: number, handler: RPCHandler): void {
    this._rpc.listen(rpcId, handler);
  }

  /**
   * Apply buffered server frames as of `now`: run the handlers of queued
   * server-to-client requests, then interpolate or snap replicated components
   * into the world.
   *
   * RPC replies are not handled here. A reply settles its
   * {@link ClientWorld.invoke} call when it arrives, so no call waits for this
   * method; only requests the server makes on this client are queued for it,
   * which keeps their handlers in the world's phase order. State that arrived in
   * the same frame as a reply is applied here, possibly after interpolation
   * delay.
   *
   * A snapshot that cannot be decoded when it is applied is a protocol error, not
   * an exception: the snapshot names a wire type this world did not register (a
   * server built from a newer protocol version), its payload is malformed, or an
   * `Exclusive` relationship snapshot lists more than one target. `apply` does
   * not throw for it. It closes the client the way {@link ClientWorld.close}
   * does, so `disconnect` fires once with
   * `{ code: CLOSE_PROTOCOL_ERROR_CODE, reason }` (see
   * {@link ClientWorldDisconnectEvent}) and pending calls reject with
   * `RPC_CLOSED_CODE`, and it applies nothing more from that diff: the snapshots
   * after the bad one and every component removal in the diff are dropped, while
   * the entities the diff removes (see below) and the snapshots before the bad
   * one stay applied. The replicated entities stay in place, as after any
   * `close()`; a later baseline on a new socket resynchronizes them.
   *
   * That handling covers only decoding at this point. An exception thrown by
   * application code while a valid snapshot is applied, such as an `on("set")`
   * hook running as the component is attached, is an application bug and still
   * propagates out of `apply` without closing the client. The decoding the diff
   * buffer does earlier, while it blends the snapshots of components that have an
   * interpolator, is not covered either: a payload that fails there still throws
   * out of `apply`.
   *
   * A removal of a component that
   * another component on the entity brings through `With` is skipped, so the entity keeps it: a
   * server can replace the source of a client-local component (a streamed pose by a dead-reckoned
   * one) in one diff, setting the new source and removing the old component, and the entity never
   * goes without it. The rule applies to this network removal of a plain component only; destroying
   * the entity through a reset removes everything, and a relationship is removed as sent.
   * A bringer set by the same diff counts as present even before its snapshot is attached.
   *
   * A diff applies in a fixed order, which is what lets an entity id that the
   * server reuses mean two entities in one diff:
   *
   * 1. The entities the diff resets (removes outright) are destroyed. A reset
   *    applies only once: the server repeats it in every delta whose span
   *    includes it, and the diff buffer hands out only the resets newer than the
   *    state the world already holds, so an overlapping delta does not destroy and
   *    rebuild the entity again.
   * 2. The snapshots are applied, creating or updating entities. A snapshot of an
   *    eid the diff reset in step 1 belongs to the entity that took the eid
   *    after the removal: it creates a new entity, with none of the destroyed one's
   *    components, client-local state or edges, and its `add` hooks and `enter`
   *    events fire. A snapshot of an eid whose reset was applied already updates
   *    the entity in place.
   * 3. The removals of single components are applied.
   *
   * Registered as two systems in the `ON_LOAD` phase, `ClientWorld:Pull` then
   * `ClientWorld:Apply`, so `progress()` drives it: step 1 runs in the first, and
   * the world flushes the destruction before the second applies steps 2 and 3. That
   * flush is what frees the eid for the new entity. `apply` does the same in one
   * call, which is only correct outside a system or `defer` scope (inside one the
   * destruction stays queued, and the snapshots of a reused eid would reach the
   * entity being destroyed), so call it directly only for a world with no tick loop.
   *
   * @param now - Timestamp in milliseconds to interpolate towards.
   */
  public apply(now: number): void {
    this._pull(now);
    this._applyPulled();
  }

  /**
   * Ack the latest applied frame to the server, with the current input, any queued RPCs, and
   * the RPC low watermark (`rpcSettledBelow`) that tells the server which of this client's
   * calls have settled, so it can drop the replies it kept for them and ignore late copies of
   * their requests. The watermark is left off the wire while it is `0`: until the client has
   * made a call and its oldest one has settled.
   *
   * When the client holds an optimistic frame it cannot apply yet, because the frames it was
   * built on never arrived, the ack also reports the gap, once, so the server falls back to
   * deltas from the ack. The report is dropped if a late frame has closed the gap by then.
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
    const rpcSettledBelow = this._rpc.settledBelow;
    const ackFrame = this._diffBuffer.version < 0 ? 0 : this._diffBuffer.version;
    const gap = this._diffBuffer.takeGap();
    const encoder = new Encoder(this._encodeBuffer);
    encoder.write(new Client2Server({ ackFrame, input: this._input, rpc, rpcSettledBelow, gap }));
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
   * {@link ClientWorld.invoke} calls made until a new socket is attached. A call
   * whose reply already arrived has settled with it and is left alone; queued
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
   * `RPCError` carrying code `RPC_CLOSED_CODE`; server-to-client requests still
   * queued for {@link ClientWorld.apply} are dropped unrun; replicated entities
   * are destroyed, which fires their components' `remove` hooks; the diff
   * buffer resets; the ack timer stops and the socket closes; and finally every
   * other entity is destroyed through `World.dispose()`. These include the
   * client-local ones — UI, effects, `DrawBy` children — and destroying them
   * fires their `remove` hooks too, so render resources such as Phaser
   * GameObjects are released the same way as the replicated ones. A call whose
   * reply already arrived has settled with it, so it is not among the rejected
   * ones.
   *
   * The client's own component, module, query, system and phase entities are
   * destroyed last, releasing singleton resources through their `remove` hooks.
   * Inside `progress()`, infrastructure stays alive until `endFrame()` and the
   * remaining systems still run. Outside a tick, an enclosing deferred queue
   * drains before infrastructure teardown. Release resources in `remove` hooks,
   * not system `exit` callbacks. `World.dispose()` documents ordering and the
   * synchronous-hook exception, including calls from a
   * `disconnect` handler that {@link ClientWorld.apply} triggers by closing the
   * client for a protocol error.
   *
   * Idempotent, and safe to call on a world that never connected. `VecsSocket`
   * has no `off`, so after dispose the `receive` and `disconnect` handlers are
   * left attached but do nothing: a late frame cannot revive the world, and
   * dispose's own `disconnect` is not re-emitted. Reconnecting or re-attaching
   * a socket to a disposed world throws — build a new `ClientWorld` instead.
   */
  public override dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._rpc.abortPending(
      new RPCError(RPC_CLOSED_CODE, "ClientWorld disposed before the RPC completed")
    );
    this._rpcInbox.length = 0;
    this._pulled = undefined;
    this._destroyNetworkEntities();
    this._diffBuffer.reset();
    this.close();
    super.dispose();
  }

  private _receive(socket: VecsSocket, data: Uint8Array): void {
    // A frame that outlives the connection (a retransmit of the close frame,
    // a straggler from a replaced socket) must not revive the world. A replaced
    // socket stays attached, so its frames are told apart here, by the same rule
    // _handleDisconnect applies to its disconnect: they belong to the old
    // connection, not the current one.
    if (this._disposed || this._disconnected || socket !== this._socket) {
      return;
    }
    let message: Server2Client;
    try {
      message = new Decoder(data).read(Server2Client);
    } catch (error) {
      // A frame that cannot be decoded — truncated or random bytes, or a field tag
      // from a newer protocol version — must not throw into the transport.
      this._closeForProtocolError(error);
      return;
    }
    // The server's low watermark comes first: it frees the replies this client was
    // keeping for server calls that have settled, and it is what apply() judges
    // the requests queued below against.
    this._rpc.setPeerSettledBelow(message.rpcSettledBelow);
    if (message.rpc.length > 0) {
      // Replies settle their calls now, so an awaited invoke() does not depend on
      // the world being applied and its request stops being resent. They run
      // before the diff and the close notice: a reply that shares a frame with a
      // close notice must settle before _handleDisconnect aborts what is left.
      // Requests wait for apply(), which keeps their handlers in phase order.
      let responses: RPC[] | undefined;
      for (const incoming of message.rpc) {
        if (incoming.rpcId === RPC_RESPONSE_ID) {
          (responses ??= []).push(incoming);
        } else {
          this._rpcInbox.push(incoming);
        }
      }
      if (responses) {
        this._rpc.process(responses);
      }
    }
    if (message.diff && !this._pushDiff(message.diff, message.optimistic)) {
      // The diff could not be read or buffered and the client is already closed:
      // the close notice in the same frame is not handled.
      return;
    }
    if (message.close) {
      this._handleServerClose(message.close);
    }
  }

  /**
   * The server sent something this client cannot decode or accept: a frame, a
   * component snapshot inside one, or a diff that starts after the last frame this
   * client acknowledged without the server marking it optimistic. Usually the two
   * sides were built from incompatible protocol versions. Disconnect through
   * {@link ClientWorld.close}, so `disconnect` fires once with a notice carrying
   * {@link CLOSE_PROTOCOL_ERROR_CODE} and a reason that starts `protocol error:`,
   * pending calls reject with `RPC_CLOSED_CODE`, the ack timer stops and the
   * socket closes, instead of throwing into the transport or out of
   * {@link ClientWorld.apply}. Nothing is sent to the server: the protocol has no
   * client-to-server close notice.
   *
   * @param error - What the decoder or the diff buffer threw.
   */
  private _closeForProtocolError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this._closeNotice = { code: CLOSE_PROTOCOL_ERROR_CODE, reason: `protocol error: ${message}` };
    this.close();
  }

  /**
   * The server closed the session on purpose. Ack the frame that carried the
   * notice — its delivery receipt is what lets the server close promptly —
   * then disconnect with the notice. Replies in the same frame have already
   * settled their calls: {@link ClientWorld._receive} handles them first.
   */
  private _handleServerClose(notice: CloseNotice): void {
    // Stashed first: if the ack itself fails to send, that failure disconnects
    // the world, and it must still report the server's reason.
    this._closeNotice = notice;
    this.send();
    this._handleDisconnect(this._socket);
  }

  /**
   * Read a received diff and hand it to the diff buffer.
   *
   * Only the data steps are guarded: reading the snapshots out of the diff, and
   * buffering it. A diff that fails either is a protocol error: a snapshot's
   * envelope is malformed, or the diff starts after the last frame this client
   * acknowledged and is not marked optimistic, which a server that honors acks
   * never sends. A baseline is read before anything is torn down, so one that
   * cannot be read leaves the replicated entities in place. Destroying them and emitting `reset` run application
   * hooks, so they stay outside the guard and what they throw propagates.
   *
   * @param sd - The diff decoded from the frame.
   * @param optimistic - The frame carried the optimistic marker, so the diff may start past the
   *   newest frame this client has: the diff buffer holds it until that frame arrives.
   * @returns `false` when the diff could not be read or buffered: the client has
   *   been closed for a protocol error and the caller must handle nothing more
   *   from the frame. `true` otherwise, including for a stale baseline that was
   *   skipped.
   */
  private _pushDiff(sd: StateDiff, optimistic: boolean): boolean {
    // A diff with fromFrame === 0 is a full baseline: the complete authoritative
    // state at sd.toFrame. The server sends one when a session starts and
    // whenever the client has fallen so far behind that frames it has not acked
    // have left the server's history window -- most commonly a backgrounded tab,
    // where the render loop (and therefore DiffBuffer.pull) is suspended and
    // acks are throttled. It sends no further state until the client acks the
    // baseline, and sends another only if it presumes the first lost, so a
    // client sees a baseline at connect and after a real stall, not one per
    // frame, and not for a view that is merely quiet.
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
    const baseline = sd.fromFrame === 0;
    // Skip baselines we have already advanced past (duplicates or, with the
    // unordered transport, stragglers). After a reconnect the server may have
    // restarted its frame counter, so a forced reset overrides this. A skipped
    // baseline is never read.
    if (baseline && !this._forceBaselineReset && sd.toFrame <= this._diffBuffer.version) {
      return true;
    }
    // Read the diff before touching the world: a baseline that cannot be read must
    // not destroy the entities it would have replaced.
    let diff: Diff;
    try {
      diff = diffFromStateDiff(sd);
    } catch (error) {
      this._closeForProtocolError(error);
      return false;
    }
    if (!baseline) {
      return this._bufferDiff(diff, optimistic);
    }
    this._forceBaselineReset = false;
    const initial = !this._baselineApplied;
    this._baselineApplied = true;
    this._destroyNetworkEntities();
    this._diffBuffer.reset();
    if (!this._bufferDiff(diff, false)) {
      return false;
    }
    this.events.emit("reset", { initial, fromFrame: sd.fromFrame, toFrame: sd.toFrame });
    return true;
  }

  /**
   * Hand a diff to the diff buffer, which rejects one that starts after the last
   * frame this client acknowledged unless the server marked it optimistic. That is
   * a protocol error, so the client is closed instead of the rejection throwing
   * into the transport.
   *
   * @returns `false` when the buffer rejected the diff and the client was closed.
   */
  private _bufferDiff(diff: Diff, optimistic: boolean): boolean {
    try {
      this._diffBuffer.push(diff, optimistic);
    } catch (error) {
      this._closeForProtocolError(error);
      return false;
    }
    return true;
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

  /**
   * Step 1 of {@link ClientWorld.apply}: run the queued server-to-client request handlers, take
   * the diff for `now` out of the buffer, and destroy the entities it resets. The diff
   * waits in `_pulled` for {@link ClientWorld._applyPulled}.
   */
  private _pull(now: number): void {
    if (this._rpcInbox.length > 0) {
      const incoming = this._rpcInbox.splice(0);
      this._rpc.process(incoming);
    }
    const diff = this._diffBuffer.pull(now);
    this._pulled = diff;
    // A diff may name an entity this world never materialized: its creation was merged away.
    diff.resets?.forEach((_, eid) => this.getEntity(eid)?.destroy());
  }

  /**
   * Steps 2 and 3 of {@link ClientWorld.apply}: apply the snapshots of the diff
   * {@link ClientWorld._pull} took, then its removals of single components.
   *
   * Stops at the first snapshot that cannot be decoded, which closes the client, so the
   * snapshots after it and the component removals are dropped.
   */
  private _applyPulled(): void {
    const diff = this._pulled;
    if (diff === undefined) {
      return;
    }
    this._pulled = undefined;
    for (const snapshot of diff.snapshots) {
      if (!this._applySnapshot(snapshot)) {
        return;
      }
    }
    const removed = diff.removed;
    if (removed === undefined) {
      return;
    }
    this._withRemovalKeys = undefined;
    try {
      for (const key of removed) {
        const [eid, wireType] = cid_unpack(key);
        this._removeComponent(eid, wireType, diff);
      }
    } finally {
      this._withRemovalKeys = undefined;
    }
  }

  /**
   * Decode one snapshot and apply it to its entity.
   *
   * Only the decode is guarded. An exception from creating the entity or from
   * attaching the component, for example an application hook that throws, is an
   * application bug and propagates.
   *
   * @param snapshot - Snapshot from the diff buffer.
   * @returns `false` when the snapshot could not be decoded: the client has been
   *   closed for a protocol error and the caller must apply nothing more from
   *   the diff. `true` once the snapshot is applied.
   */
  private _applySnapshot(snapshot: ComponentSnapshot): boolean {
    let component: ComponentInstance;
    try {
      component = this.decodeComponentSnapshot(snapshot);
    } catch (error) {
      this._closeForProtocolError(error);
      return false;
    }
    const entity = this.getOrCreateEntity(snapshot.eid, (e) => e.add(Networked));

    if (component instanceof Relationship) {
      this._applyRelationshipSnapshot(entity, component);
      return true;
    }

    entity.attach(component as object);
    return true;
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

  private _removeComponent(eid: EID, wireType: number, diff: Diff): void {
    // Merged/interpolated client diffs can contain a net removal for an entity
    // whose create snapshot was compressed away before it materialized locally.
    const entity = this.getEntity(eid);
    if (!entity) {
      return;
    }
    const registered = this.getNetworkComponent(wireType);
    if (registered === undefined || !entity.get(registered.Class)) {
      return;
    }
    // The server removed a component that another one on this entity still brings through `With`:
    // the entity keeps it, as it would for any other holder of the bringer. A server that swaps the
    // source of a client-local component, such as a streamed pose for a dead-reckoned one, relies
    // on this to keep the component present throughout.
    if (this._isBroughtByWith(entity, registered.Class, diff)) {
      return;
    }
    entity.remove(registered.Class);
  }

  // Whether a component on `entity` brings `Class` through `With`. Only the network-removal path
  // pays for the lookup, and only for a component that is there to remove. A relationship is never
  // skipped: `With` brings it one edge at a time, so no component present stands for the whole
  // relationship.
  //
  // Use the diff's final membership: a bringer set by this diff counts as present even while its
  // snapshot is queued. Otherwise a present network bringer counts only if this diff neither removes
  // it nor resets its entity. A client-local bringer is judged by entity.has alone; With does not
  // remove companions, so a local intermediate can keep bringing without a transitive walk.
  // Index removals lazily, once per applied diff, only upon reaching a present network bringer.
  private _isBroughtByWith(entity: Entity, Class: ComponentClass, diff: Diff): boolean {
    const component = this.component(Class);
    if (component.meta.isRelationship) {
      return false;
    }
    for (const bringer of component.children(With)) {
      if (this._diffSets(diff, entity, bringer)) {
        return true;
      }
      if (!entity.has(bringer)) {
        continue;
      }
      const registered = this.networkComponents.find((component) => component.eid === bringer.eid);
      if (registered === undefined) {
        return true;
      }
      if (diff.resets?.has(entity.eid)) {
        continue;
      }
      this._withRemovalKeys ??= new Set(diff.removed);
      if (!this._withRemovalKeys.has(cid_pack(entity.eid, registered.wireType))) {
        return true;
      }
    }
    return false;
  }

  // Whether `diff` carries a snapshot of the component `bringer` for `entity`.
  private _diffSets(diff: Diff, entity: Entity, bringer: Entity): boolean {
    const registered = this.networkComponents.find((component) => component.eid === bringer.eid);
    return (
      registered !== undefined &&
      diff.getSnapshot(cid_pack(entity.eid, registered.wireType)) !== undefined
    );
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
    // Queued server requests are dropped unrun: a dead connection cannot carry
    // their replies, and they must never run on a later one.
    this._rpcInbox.length = 0;
    this._rpc.abortPending(
      new RPCError(RPC_CLOSED_CODE, "ClientWorld disconnected before the RPC completed")
    );
    // A reconnect may land on a server whose frame counter restarted, so the
    // next baseline can carry a lower frame than the one we last saw. Force the
    // next baseline to be adopted regardless of its frame number.
    if (this._baselineApplied) {
      this._forceBaselineReset = true;
    }
    const notice = this._closeNotice;
    this._closeNotice = undefined;
    this.events.emit("disconnect", notice);
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
