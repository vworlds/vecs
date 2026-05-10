import {
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  SessionRPC,
  encodeMessage,
  type RPCHandler,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { type ComponentClass, type IPhase, type World } from "@vworlds/vecs";
import { Decoder } from "@vworlds/vecs-wire";

const LOCAL_COMPONENT_MIN = 256;

interface RegisteredComponent {
  Class: ComponentClass;
  type: number;
}

export interface VecsClientOptions {
  world: World;
  socket?: VecsSocket;
  applyPhase?: string | IPhase;
  sendPhase?: string | IPhase;
  encodeBufferSize?: number;
  sendEveryFrame?: boolean;
  localEntityIdStart?: number;
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
  private readonly _diffQueue: Server2Client[] = [];
  private readonly _encodeBufferSize: number;
  private readonly _localEntityIdStart: number;
  private _highestReceivedFrame = 0;
  private _input: unknown;
  private _systemsInstalled = false;

  public readonly applyPhase: string | IPhase;
  public readonly sendPhase: string | IPhase;

  public constructor(options: VecsClientOptions) {
    this._world = options.world;
    this._socket = options.socket;
    this.applyPhase = options.applyPhase ?? "update";
    this.sendPhase = options.sendPhase ?? "update";
    this._encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this._localEntityIdStart =
      options.localEntityIdStart ??
      (this._world as World & { localEntityIdStart?: number }).localEntityIdStart ??
      Number.MAX_SAFE_INTEGER;

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

  public installSystems(): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    this._world
      .system("VecsClient:Apply")
      .phase(this.applyPhase)
      .run(() => this.apply());
    this._world
      .system("VecsClient:Send")
      .phase(this.sendPhase)
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

  public apply(): void {
    const messages = this._diffQueue.splice(0);
    messages.forEach((message) => {
      message.rpc.length && this._rpc.process(message.rpc);
      if (!message.diff) {
        return;
      }
      message.diff.snapshots.forEach((bytes) => this._applySnapshot(bytes));
      message.diff.removed.forEach((removed) => this._removeComponent(removed.eid, removed.type));
    });
  }

  public send(): void {
    if (!this._socket) {
      return;
    }
    const rpc = this._rpc.getOutgoing();
    this._socket.send(
      encodeMessage(
        new Client2Server({ ackFrame: this._highestReceivedFrame, input: this._input, rpc }),
        this._encodeBufferSize
      )
    );
  }

  public close(): void {
    this._socket?.close();
  }

  private _receive(data: Uint8Array): void {
    const message = new Decoder(data).read(Server2Client);
    if (message.diff) {
      this._highestReceivedFrame = Math.max(this._highestReceivedFrame, message.diff.toFrame);
    }
    this._diffQueue.push(message);
  }

  private _applySnapshot(bytes: Uint8Array): void {
    const snapshot = new Decoder(bytes).read(ComponentSnapshot);
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

export function worldPath(basePath = "/rtc/v1/world", worldName: string): string {
  return `${basePath.replace(/\/$/, "")}/${encodeURIComponent(worldName)}`;
}

function hasSyncedComponents(entity: { components: any }): boolean {
  let hasSynced = false;
  entity.components.forEach((_component: object, type: number) => {
    if (type < LOCAL_COMPONENT_MIN) {
      hasSynced = true;
    }
  });
  return hasSynced;
}
