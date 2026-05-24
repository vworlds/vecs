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
import { ComponentSnapshot, Interpolator, diffFromStateDiff } from "./interpolator.js";
import { worldPath } from "./world_path.js";

export interface ClientWorldOptions extends NetworkWorldOptions {
  socket?: VecsSocket;
  encodeBufferSize?: number;
  interpolatorBucketLength?: number;
  serverTickIntervalMs?: number;
}

export interface InstallSystemsOptions {
  applyPhase?: string | IPhase;
  sendPhase?: string | IPhase;
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
  private _socket: VecsSocket | undefined;
  private readonly _rpc = new SessionRPC();
  private readonly _rpcInbox: RPC[] = [];
  private readonly _interpolator: Interpolator;
  private readonly _encodeBuffer: Uint8Array;
  private _input: unknown;
  private _systemsInstalled = false;

  public constructor(options: ClientWorldOptions = {}) {
    super(options);
    this._encodeBuffer = new Uint8Array(options.encodeBufferSize ?? 64 * 1024);
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
  }

  public installSystems(options: InstallSystemsOptions = {}): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    const applyPhase = options.applyPhase ?? "update";
    const sendPhase = options.sendPhase ?? "update";
    this.system("ClientWorld:Apply")
      .phase(applyPhase)
      .run((now) => this.apply(now));
    this.system("ClientWorld:Send")
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

  public onDisconnect(handler: () => void): void {
    this._socket?.on("disconnect", handler);
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
    const entity = this.entity(eid);
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
}
