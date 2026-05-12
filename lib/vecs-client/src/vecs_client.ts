import {
  Client2Server,
  RPC,
  Server2Client,
  SessionRPC,
  StateDiff,
  type RPCHandler,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import {
  cid_unpack,
  getLocalComponentMin,
  type ComponentClass,
  type Entity,
  type IPhase,
  type World,
} from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { ComponentSnapshot, Interpolator, diffFromStateDiff } from "./interpolator.js";
import { worldPath } from "./world_path.js";

interface RegisteredComponent {
  Class: ComponentClass;
  type: number;
}

export interface VecsClientOptions {
  world: World;
  socket?: VecsSocket;
  encodeBufferSize?: number;
  localEntityIdStart?: number;
  interpolatorBucketLength?: number;
  serverTickIntervalMs?: number;
}

export interface InstallSystemsOptions {
  applyPhase?: string | IPhase;
  sendPhase?: string | IPhase;
}

export interface DgramConnectOptions extends Omit<VecsClientOptions, "socket"> {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  apiBasePath?: string;
  rtcConfig?: RTCConfiguration;
}

export class VecsClient {
  private readonly _world: World;
  private readonly _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  private readonly _components = new Map<number, RegisteredComponent>();
  private readonly _rpcInbox: RPC[] = [];
  private readonly _interpolator: Interpolator;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _localEntityIdStart: number;
  private _input: unknown;
  private _systemsInstalled = false;

  public constructor(options: VecsClientOptions) {
    this._world = options.world;
    this._socket = options.socket;
    this._encodeBuffer = new Uint8Array(options.encodeBufferSize ?? 64 * 1024);
    this._localEntityIdStart =
      options.localEntityIdStart ??
      (this._world as World & { localEntityIdStart?: number }).localEntityIdStart ??
      Number.MAX_SAFE_INTEGER;
    this._interpolator = new Interpolator(
      options.interpolatorBucketLength ?? 3,
      options.serverTickIntervalMs ?? 1000 / 30
    );

    if (this._socket) {
      this.attachSocket(this._socket);
    }
  }

  public static async connectDgram(options: DgramConnectOptions): Promise<VecsClient> {
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
    const client = new VecsClient({ ...options, socket });
    await socket.connect();
    return client;
  }

  public attachSocket(socket: VecsSocket): void {
    socket.on("receive", (data) => this._receive(data));
  }

  public registerComponent<C extends ComponentClass>(Class: C): void {
    const meta = this._world.getComponentMeta(Class);
    this._components.set(meta.type, { Class, type: meta.type });
  }

  public installSystems(options: InstallSystemsOptions = {}): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    const applyPhase = options.applyPhase ?? "update";
    const sendPhase = options.sendPhase ?? "update";
    this._world
      .system("VecsClient:Apply")
      .phase(applyPhase)
      .run((now) => this.apply(now));
    this._world
      .system("VecsClient:Send")
      .phase(sendPhase)
      .run(() => this.send());
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
    const diff = diffFromStateDiff(sd);
    this._interpolator.push(diff);
  }

  private _applySnapshot(snapshot: ComponentSnapshot): void {
    const registered = this._components.get(snapshot.type);
    if (!registered) {
      return;
    }
    const component = new Decoder(snapshot.payload).read(registered.Class);
    const entity = this._world.getOrCreateEntity(snapshot.eid);
    entity.attach(component as object);
  }

  private _removeComponent(eid: number, type: number): void {
    const entity = this._world.entity(eid);
    if (!entity) {
      return;
    }
    if (this._components.has(type) && entity.get(type)) {
      entity.remove(type);
    }
    this._world.flush();
    if (eid < this._localEntityIdStart && !hasSyncedComponents(entity)) {
      entity.destroy();
    }
  }
}

function hasSyncedComponents(entity: Entity): boolean {
  let hasSynced = false;
  entity.components.forEach((_component, type) => {
    if (type < getLocalComponentMin()) {
      hasSynced = true;
    }
  });
  return hasSynced;
}
