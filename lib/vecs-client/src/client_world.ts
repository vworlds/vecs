import {
  Client2Server,
  RPC,
  Server2Client,
  SessionRPC,
  StateDiff,
  ALL_COMPONENTS,
  cid_unpack,
  NetworkWorld,
  type NetworkWorldOptions,
  type RegisteredNetworkComponent,
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
  interpolators?: Iterable<readonly [ComponentClass, ComponentInterpolator]>;
}

export interface DgramConnectOptions extends Omit<ClientWorldOptions, "socket"> {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  apiBasePath?: string;
  rtcConfig?: RTCConfiguration;
}

export class ClientWorld extends NetworkWorld {
  public readonly events = new Events<ClientWorldEvents>();
  private _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  private readonly _rpcInbox: RPC[] = [];
  private readonly _diffBuffer: DiffBuffer;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _ackIntervalMs: number;
  private readonly _networkedQuery: InstanceType<typeof Query>;
  private _input: unknown;
  private _ackTimer: ReturnType<typeof setInterval> | undefined;
  private _baselineApplied = false;
  private _forceBaselineReset = false;

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
      resolveInterpolators(options.interpolators, this.networkComponents)
    );
    this.system("ClientWorld:Apply")
      .phase(ON_LOAD)
      .run((now) => this.apply(now));

    if (options.socket) {
      this.attachSocket(options.socket);
    }
  }

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
    const client = new ClientWorld({ ...options, socket });
    await socket.connect();
    return client;
  }

  public attachSocket(socket: VecsSocket): void {
    this._socket = socket;
    socket.on("receive", (data) => this._receive(data));
    socket.on("disconnect", () => this._handleDisconnect());
    this._startAckTimer();
  }

  public setInput(input: unknown): void {
    this._input = input;
  }

  public invoke(rpcId: number, params: unknown[] = []): Promise<unknown[]> {
    return this._rpc.invoke(rpcId, params).then((response) => response.params);
  }

  public listen(rpcId: number, handler: RPCHandler): void {
    this._rpc.listen(rpcId, handler);
  }

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

  public send(): void {
    if (!this._socket) {
      return;
    }
    const rpc = this._rpc.getOutgoing();
    const ackFrame = this._diffBuffer.version < 0 ? 0 : this._diffBuffer.version;
    const encoder = new Encoder(this._encodeBuffer);
    encoder.write(new Client2Server({ ackFrame, input: this._input, rpc }));
    this._socket.send(encoder.getBuffer());
  }

  public close(): void {
    this._stopAckTimer();
    this._socket?.close();
  }

  private _receive(data: Uint8Array): void {
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
    return (snapshot.payload = new Decoder(snapshot.payload).read(
      registered.Class
    ) as ComponentInstance);
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
    const relClass = component.constructor as ComponentClass;
    const targetEid = component.target as unknown as EID;

    if (!targetEid) {
      if (entity.get(relClass)) {
        entity.remove(relClass);
      }
      return;
    }

    // Create the target as an empty Networked ghost if it doesn't exist yet.
    // Its real components arrive in later snapshots and attach to the same
    // entity. This avoids any pending-link bookkeeping: retargeting,
    // child-destruction, and baseline resets all work through normal ECS
    // lifecycle without stale references.
    const target = this.getOrCreateEntity(targetEid, (e) => e.add(Networked));
    entity.set(relClass, { target });
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
  // from scratch (re-firing each entity's `enter`). query.forEach wraps in
  // beginDefer/endDefer, so destroying inside the callback is safe.
  private _destroyNetworkEntities(): void {
    this._networkedQuery.forEach((entity) => entity.destroy());
  }

  private _handleDisconnect(): void {
    this._stopAckTimer();
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

// resolveInterpolators translates the public [ComponentClass, ComponentInterpolator]
// mapping into the [wireType, ComponentInterpolator] entries DiffBuffer consumes,
// by looking up each class in the registered network components. A class that is
// not a registered network component throws — interpolators only apply to
// networked types.
function resolveInterpolators(
  interpolators: Iterable<readonly [ComponentClass, ComponentInterpolator]> | undefined,
  registered: readonly RegisteredNetworkComponent[]
): Array<readonly [number, ComponentInterpolator]> {
  if (!interpolators) {
    return [];
  }
  const resolved: Array<readonly [number, ComponentInterpolator]> = [];
  for (const [Class, interpolator] of interpolators) {
    const entry = registered.find((r) => r.Class === Class);
    if (!entry) {
      throw new Error(
        `interpolators: ${Class.name ?? "component"} is not a registered network component`
      );
    }
    resolved.push([entry.wireType, interpolator]);
  }
  return resolved;
}
