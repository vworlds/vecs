import {
  Client2Server,
  ComponentSnapshot,
  RemovedComponent,
  Server2Client,
  SessionRPC,
  StateDiff,
  encodeMessage,
  type RPCHandler,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { type Component, type ComponentClass, type IPhase, type World } from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";

export class Networked {}

interface RegisteredComponent {
  Class: ComponentClass;
  type: number;
  name: string;
}

interface ServerClientSession {
  socket: VecsSocket;
  rpc: SessionRPC;
  ackFrame: number;
  input: unknown;
}

export interface VecsServerWorldOptions {
  collectPhase?: string | IPhase;
  sendPhase?: string | IPhase;
  encodeBufferSize?: number;
}

export class VecsServerWorld {
  private readonly _components: RegisteredComponent[] = [];
  private readonly _sessions = new Map<string, ServerClientSession>();
  private readonly _rpcHandlers = new Map<number, RPCHandler>();
  private readonly _dirty = new Map<string, { eid: number; type: number }>();
  private readonly _removed = new Map<string, RemovedComponent>();
  private readonly _encodeBufferSize: number;
  private _frame = 0;
  private _systemsInstalled = false;

  public constructor(
    public readonly name: string,
    public readonly world: World,
    options: VecsServerWorldOptions = {}
  ) {
    this._encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this.collectPhase = options.collectPhase ?? "update";
    this.sendPhase = options.sendPhase ?? "update";
  }

  public collectPhase: string | IPhase;
  public sendPhase: string | IPhase;

  public registerComponent<C extends ComponentClass>(Class: C): void {
    const meta = this.world.getComponentMeta(Class);
    this._components.push({ Class, type: meta.type, name: meta.componentName });
  }

  public attach(listener: VecsSocketListener): void {
    listener.on("new", (socket) => this.addSocket(socket));
  }

  public addSocket(socket: VecsSocket): void {
    const session: ServerClientSession = {
      socket,
      rpc: new SessionRPC(),
      ackFrame: 0,
      input: undefined,
    };
    this._rpcHandlers.forEach((handler, rpcId) => session.rpc.listen(rpcId, handler));
    this._sessions.set(socket.id, session);
    this._markCurrentStateDirty();
    socket.on("receive", (data) => this._receive(session, data));
    socket.on("disconnect", () => this._sessions.delete(socket.id));
  }

  public listen(rpcId: number, handler: RPCHandler): void {
    this._rpcHandlers.set(rpcId, handler);
    this._sessions.forEach((session) => session.rpc.listen(rpcId, handler));
  }

  public getInput(socketId: string): unknown {
    return this._sessions.get(socketId)?.input;
  }

  public installSystems(): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;

    this._components.forEach((registered) => {
      this.world
        .system(`VecsServer:${this.name}:${registered.name}`)
        .phase(this.collectPhase)
        .requires(Networked, registered.Class)
        .update(registered.Class, (entity) => this._markDirty(entity.eid, registered.type))
        .track()
        .exit((entity) => this._markRemoved(entity.eid, registered.type));
    });

    this.world
      .system(`VecsServer:${this.name}:Flush`)
      .phase(this.sendPhase)
      .run(() => this.flush());
  }

  public flush(): void {
    if (this._sessions.size === 0) {
      this._dirty.clear();
      this._removed.clear();
      return;
    }

    const toFrame = ++this._frame;
    const snapshots: Uint8Array[] = [];
    const removed: RemovedComponent[] = [];

    this._dirty.forEach(({ eid, type }, key) => {
      const entity = this.world.entity(eid);
      const component = entity?.get(type);
      const isStillSynced = entity?.get(Networked) && component;
      if (!isStillSynced) {
        this._removed.set(key, new RemovedComponent({ eid, type }));
        return;
      }
      snapshots.push(this._encodeSnapshot(eid, type, component));
      this._removed.delete(key);
    });

    this._removed.forEach((entry, key) => {
      const entity = this.world.entity(entry.eid);
      if (entity?.get(Networked) && entity.get(entry.type)) {
        return;
      }
      removed.push(entry);
      this._dirty.delete(key);
    });

    this._sessions.forEach((session) => {
      const rpc = session.rpc.getOutgoing();
      if (snapshots.length === 0 && removed.length === 0 && rpc.length === 0) {
        return;
      }
      const diff = new StateDiff({
        fromFrame: session.ackFrame,
        toFrame,
        snapshots,
        removed,
      });
      session.socket.send(encodeMessage(new Server2Client({ diff, rpc }), this._encodeBufferSize));
    });

    this._dirty.clear();
    this._removed.clear();
  }

  private _receive(session: ServerClientSession, data: Uint8Array): void {
    const message = new Decoder(data).read(Client2Server);
    session.ackFrame = Math.max(session.ackFrame, message.ackFrame);
    session.input = message.input;
    if (message.rpc.length > 0) {
      session.rpc.process(message.rpc);
    }
  }

  private _markDirty(eid: number, type: number): void {
    const key = componentKey(eid, type);
    this._dirty.set(key, { eid, type });
  }

  private _markRemoved(eid: number, type: number): void {
    const key = componentKey(eid, type);
    this._removed.set(key, new RemovedComponent({ eid, type }));
  }

  private _markCurrentStateDirty(): void {
    this.world.entities.forEach((entity) => {
      if (!entity.get(Networked)) {
        return;
      }
      this._components.forEach((component) => {
        if (entity.get(component.type)) {
          this._markDirty(entity.eid, component.type);
        }
      });
    });
  }

  private _encodeSnapshot(eid: number, type: number, component: Component): Uint8Array {
    const encoder = new Encoder(new Uint8Array(this._encodeBufferSize));
    encoder.write(component);
    return encodeMessage(
      new ComponentSnapshot({ eid, type, payload: encoder.getBuffer() }),
      this._encodeBufferSize
    );
  }
}

export interface VecsServerOptions extends VecsServerWorldOptions {
  apiBasePath?: string;
}

export class VecsServer {
  private readonly _worlds = new Map<string, VecsServerWorld>();

  public constructor(private readonly _options: VecsServerOptions = {}) {}

  public registerWorld(name: string, world: World): VecsServerWorld {
    const serverWorld = new VecsServerWorld(name, world, this._options);
    this._worlds.set(name, serverWorld);
    return serverWorld;
  }

  public async listen(app: unknown, dgramOptions: Record<string, unknown> = {}): Promise<void> {
    const { SocketListener } = (await import("@vworlds/dgram-server")) as unknown as {
      SocketListener: new (app: unknown, options: Record<string, unknown>) => VecsSocketListener;
    };
    this._worlds.forEach((serverWorld, name) => {
      const listener = new SocketListener(app, {
        ...dgramOptions,
        label: "dgram",
        apiBasePath: worldPath(this._options.apiBasePath, name),
      });
      serverWorld.attach(listener);
    });
  }
}

export function worldPath(basePath = "/rtc/v1/world", worldName: string): string {
  return `${basePath.replace(/\/$/, "")}/${encodeURIComponent(worldName)}`;
}

function componentKey(eid: number, type: number): string {
  return `${eid}:${type}`;
}
