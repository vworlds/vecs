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
  type RPCHandler,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { type ComponentInstance, type IPhase } from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { EventEmitter } from "eventemitter3";
import { ComponentSnapshot, Interpolator, diffFromStateDiff } from "./interpolator.js";
import { worldPath } from "./world_path.js";

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
}

export interface InstallSystemsOptions {
  applyPhase?: string | IPhase;
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
  public readonly events = new EventEmitter<ClientWorldEvents>();
  private _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  private readonly _rpcInbox: RPC[] = [];
  private readonly _interpolator: Interpolator;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _ackIntervalMs: number;
  private _input: unknown;
  private _ackTimer: ReturnType<typeof setInterval> | undefined;
  private _baselineApplied = false;
  private _forceBaselineReset = false;
  private _systemsInstalled = false;

  public constructor(options: ClientWorldOptions = {}) {
    const localEntityIdStart = options.localEntityIdStart ?? DEFAULT_CLIENT_LOCAL_ENTITY_ID_START;
    super({
      ...options,
      localEntityIdStart,
      networkEntityReuseWaitFrames: 0,
    });
    this._encodeBuffer = new Uint8Array(options.encodeBufferSize ?? 64 * 1024);
    this._ackIntervalMs = options.ackIntervalMs ?? 1000 / 30;
    this._interpolator = new Interpolator(
      options.interpolatorBucketLength ?? 3,
      options.serverTickIntervalMs ?? 1000 / 30,
      (snapshot) => this.decodeComponentSnapshot(snapshot)
    );

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

  public installSystems(options: InstallSystemsOptions = {}): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    const applyPhase = options.applyPhase ?? "update";
    this.system("ClientWorld:Apply")
      .phase(applyPhase)
      .run((now) => this.apply(now));
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
    const diff = this._interpolator.pull(now);
    diff.snapshots.forEach((snapshot) => this._applySnapshot(snapshot));
    (diff.removed as number[] | undefined)?.forEach((key) => {
      const [eid, type] = cid_unpack(key);
      this._removeComponent(eid, type);
    });
  }

  public send(): void {
    if (!this._socket) {
      return;
    }
    const rpc = this._rpc.getOutgoing();
    const ackFrame = this._interpolator.version < 0 ? 0 : this._interpolator.version;
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
    // render loop (and therefore Interpolator.pull) is suspended and acks are
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
      if (!this._forceBaselineReset && sd.toFrame <= this._interpolator.version) {
        return;
      }
      this._forceBaselineReset = false;
      const initial = !this._baselineApplied;
      this._baselineApplied = true;
      this._destroyNetworkEntities();
      this._interpolator.reset();
      this._interpolator.push(diffFromStateDiff(sd));
      this.events.emit("reset", { initial, fromFrame: sd.fromFrame, toFrame: sd.toFrame });
      return;
    }
    this._interpolator.push(diffFromStateDiff(sd));
  }

  public decodeComponentSnapshot(snapshot: ComponentSnapshot): ComponentInstance {
    if (!(snapshot.payload instanceof Uint8Array)) {
      return snapshot.payload;
    }
    const registered = this.getNetworkComponent(snapshot.type);
    if (!registered) {
      throw new Error(`Received snapshot for unregistered component type ${snapshot.type}`);
    }
    return (snapshot.payload = new Decoder(snapshot.payload).read(
      registered.Class
    ) as ComponentInstance);
  }

  private _applySnapshot(snapshot: ComponentSnapshot): void {
    const component = this.decodeComponentSnapshot(snapshot);
    const entity = this.getOrCreateEntity(snapshot.eid);
    entity.attach(component as object);
  }

  private _removeComponent(eid: number, type: number): void {
    // Merged/interpolated client diffs can contain a net removal for an entity
    // whose create snapshot was compressed away before it materialized locally.
    const entity = this.getEntity(eid);
    if (!entity) {
      return;
    }
    if (type === ALL_COMPONENTS) {
      entity.destroy();
      return;
    }
    if (this.getNetworkComponent(type) && entity.get(type)) {
      entity.remove(type);
    }
  }

  // Destroy every server-owned entity so an incoming baseline can recreate them
  // from scratch (re-firing each entity's `enter`). Local entities -- particles,
  // UI, anything the client spawns past `localEntityIdStart` -- live in a
  // separate pool and are left alone. Iterating a snapshot of the map keeps the
  // destroy, which mutates it, safe.
  private _destroyNetworkEntities(): void {
    const pool = this.pools.find((p) => p.name === "network_entity");
    if (!pool) {
      return;
    }
    for (const entity of [...this.entities.values()]) {
      if (entity.eid >= pool.min && (pool.max === undefined || entity.eid <= pool.max)) {
        entity.destroy();
      }
    }
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
