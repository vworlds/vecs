import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  SessionRPC,
  StateDiff,
  type RPCHandler,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import {
  type Component,
  type ComponentClass,
  type Entity,
  ALL_COMPONENTS,
  type IPhase,
  type System,
  type World,
  cid_pack,
} from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { NetworkClient, NetworkInput, Networked } from "./networked.js";
import { TrackerCache, View } from "./view.js";

interface RegisteredComponent {
  Class: ComponentClass;
  type: number;
  name: string;
}

interface SyncSystem {
  type: number;
  name: string;
  Class: ComponentClass;
  system: System;
}

class ServerClientSession {
  public readonly rpc = new SessionRPC();
  public ackFrame = 0;
  public socket!: VecsSocket;
  public entity!: Entity;

  public destroy(): void {}
}

interface Update {
  entity: Entity;
  type: number;
  component: Component | undefined; // undefined => removal
}

export interface VecsServerOptions {
  encodeBufferSize?: number;
}

export interface InstallSystemsOptions {
  collectPhase: string | IPhase;
  sendPhase: string | IPhase;
}

export class VecsServer {
  private readonly _components: RegisteredComponent[] = [];
  private readonly _sessions = new Map<string, ServerClientSession>();
  private readonly _rpcHandlers = new Map<number, RPCHandler>();
  private readonly _updates = new Map<number, Update>();
  private readonly _syncSystems: SyncSystem[] = [];
  private readonly _snapshotCache = new Map<number, EncodedSnapshot>();
  private readonly _trackerCache: TrackerCache;
  private readonly _encodeBuffer: Uint8Array;
  private _clients!: System<[typeof View, typeof ServerClientSession]>;
  private _frame = 0;
  private _systemsInstalled = false;

  public constructor(
    public readonly name: string,
    public readonly world: World,
    options: VecsServerOptions = {}
  ) {
    const encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this._encodeBuffer = new Uint8Array(encodeBufferSize);
    this._trackerCache = new TrackerCache(world);
    ensureRegistered(world, Networked);
    ensureRegistered(world, NetworkClient);
    ensureRegistered(world, NetworkInput);
    ensureRegistered(world, View);
    ensureRegistered(world, ServerClientSession);
  }

  public registerComponent<C extends ComponentClass>(Class: C): void {
    const meta = this.world.getComponentMeta(Class);
    this._components.push({ Class, type: meta.type, name: meta.componentName });
  }

  /** @internal */
  public _attach(listener: VecsSocketListener): void {
    listener.on("new", (socket) => this._onNewConnection(socket));
  }

  public handleRpc(rpcId: number, handler: RPCHandler): void {
    this._rpcHandlers.set(rpcId, handler);
    this._sessions.forEach((session) => session.rpc.listen(rpcId, handler));
  }

  public installSystems(options: InstallSystemsOptions): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    const { collectPhase, sendPhase } = options;

    this.world.getComponentMeta(Networked).onRemove((entity) => {
      this._record(entity, ALL_COMPONENTS, undefined);
    });
    this.world.hook(ServerClientSession).onRemove((_entity, session) => {
      session.destroy();
    });

    this._clients = this.world
      .system(`VecsServer:${this.name}:View`)
      .phase(collectPhase)
      .requires(View, ServerClientSession)
      .update(View, [ServerClientSession], (_entity, view, [_session]) => {
        view._refreshTracker(this._trackerCache);
      })
      .exit([View, ServerClientSession], (_entity, [view, _session]) => {
        view._releaseTrackers(this._trackerCache);
      })
      .track();

    this._components.forEach((registered) => {
      const system = this.world
        .system(`VecsServer:${this.name}:${registered.name}`)
        .phase(collectPhase)
        .requires(Networked, registered.Class)
        .update(registered.Class, (entity, component) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.type));
          this._record(entity, registered.type, component);
        })
        .exit((entity) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.type));
          this._record(entity, registered.type, undefined);
        })
        .track();
      this._syncSystems.push({
        type: registered.type,
        name: registered.name,
        Class: registered.Class,
        system,
      });
    });

    this.world
      .system(`VecsServer:${this.name}:Flush`)
      .phase(sendPhase)
      .run(() => this.flush());
  }

  public flush(): void {
    if (this._sessions.size === 0) {
      this._updates.clear();
      return;
    }

    const toFrame = ++this._frame;

    this._clients.forEach([View, ServerClientSession], (e, [view, session]) => {
      view._reconcileVisibility();
      view._releaseOldTracker(this._trackerCache);

      const snapshots: EncodedSnapshot[] = [];
      const removed: number[] = [];

      view._exitedView.forEach((entity) => {
        removed.push(cid_pack(entity.eid, ALL_COMPONENTS));
      });
      view._enteredView.forEach((entity) => {
        this._pushEntitySnapshots(entity, snapshots);
      });

      this._updates.forEach((u) => {
        if (view._enteredView.has(u.entity) || !view.canSee(u.entity)) {
          return;
        }
        if (u.component) {
          snapshots.push(this._encodeSnapshot(u.entity.eid, u.type, u.component));
        } else {
          removed.push(cid_pack(u.entity.eid, u.type));
        }
      });

      view._enteredView.clear();
      view._exitedView.clear();

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
      session.socket.send(this._encode(new Server2Client({ diff, rpc })));
    });

    this._updates.clear();
  }

  private _onNewConnection(socket: VecsSocket): void {
    const entity = this.world.entity().add(Networked).add(NetworkClient).add(View);
    const session = new ServerClientSession();
    session.socket = socket;
    session.entity = entity;
    entity.attach(session);
    entity.set(NetworkClient, { id: socket.id });
    this._rpcHandlers.forEach((handler, rpcId) => session.rpc.listen(rpcId, handler));
    this._sessions.set(socket.id, session);

    socket.on("receive", (data) => this._receive(session, data));
    socket.on("disconnect", () => this._onDisconnect(socket.id));
  }

  private _onDisconnect(socketId: string): void {
    const session = this._sessions.get(socketId);
    if (!session) {
      return;
    }
    this._sessions.delete(socketId);
    session.entity.destroy();
  }

  private _receive(session: ServerClientSession, data: Uint8Array): void {
    const message = new Decoder(data).read(Client2Server);
    session.ackFrame = Math.max(session.ackFrame, message.ackFrame);
    if (message.input !== undefined) {
      session.entity.set(NetworkInput, { input: message.input });
    }
    if (message.rpc.length > 0) {
      session.rpc.process(message.rpc);
    }
  }

  private _record(entity: Entity, type: number, component: Component | undefined): void {
    this._updates.set(cid_pack(entity.eid, type), { entity, type, component });
  }

  private _pushEntitySnapshots(entity: Entity, snapshots: EncodedSnapshot[]): void {
    this._components.forEach((registered) => {
      const component = entity.get(registered.type);
      if (!component) {
        return;
      }
      snapshots.push(this._encodeSnapshot(entity.eid, registered.type, component));
    });
  }

  private _encodeSnapshot(eid: number, type: number, component: Component): EncodedSnapshot {
    const cid = cid_pack(eid, type);
    const cached = this._snapshotCache.get(cid);
    if (cached) {
      return cached;
    }

    const payloadEncoder = new Encoder(this._encodeBuffer);
    payloadEncoder.write(component);
    const payload = payloadEncoder.getBuffer().slice();
    const snapshot = new EncodedSnapshot(
      this._encode(new ComponentSnapshot({ cid, payload })),
      cid
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

function ensureRegistered(world: World, Class: ComponentClass): void {
  if (!world._tryGetComponentMeta(Class)) {
    world.registerComponent(Class);
  }
}
