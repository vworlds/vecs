import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  SessionRPC,
  StateDiff,
  ALL_COMPONENTS,
  cid_pack,
  NetworkWorld,
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
  ON_STORE,
  Phase,
  PRE_STORE,
  type System,
} from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { HISTORY_LENGTH, History } from "./history.js";
import { NetworkClient, NetworkInput, Networked } from "./networked.js";
import { TrackerCache, View } from "./view.js";

interface RegisteredComponent {
  Class: ComponentClass;
  type: number;
}

class ServerClientSession {
  public readonly baseFrame: number;
  public readonly history: History;
  public readonly rpc = new SessionRPC();
  public ackFrame: number;
  public lastSeenMs = 0;
  public needsFullSnapshot = true;
  public needsResync = false;
  public socket!: VecsSocket;
  public entity!: Entity;

  public constructor(lastFrame = -1) {
    this.baseFrame = lastFrame;
    this.ackFrame = lastFrame;
    this.history = new History(HISTORY_LENGTH, lastFrame);
  }

  public destroy(): void {}
}

interface Update {
  entity: Entity;
  type: number;
  component: ComponentInstance | undefined; // undefined => removal
}

export interface ServerWorldOptions extends NetworkWorldOptions {
  name?: string;
  encodeBufferSize?: number;
  disconnectGraceMs?: number;
}

export interface InstallSystemsOptions {
  collectPhase?: string | Entity;
  sendPhase?: string | Entity;
}

export class ServerWorld extends NetworkWorld {
  public readonly name: string;
  private readonly _components: readonly RegisteredComponent[];
  private readonly _sessions = new Map<string, ServerClientSession>();
  private readonly _rpcHandlers = new Map<number, RPCHandler>();
  private readonly _updates = new Map<number, Update>();
  private readonly _snapshotCache = new Map<number, EncodedSnapshot>();
  private readonly _trackerCache: TrackerCache;
  private readonly _encodeBuffer: Uint8Array;
  private readonly _disconnectGraceMs: number;
  private _clients!: System<[typeof View, typeof ServerClientSession]>;
  private _frame = 1;
  private _systemsInstalled = false;

  public constructor(options: ServerWorldOptions = {}) {
    super(options);
    this.name = options.name ?? "main";
    const encodeBufferSize = options.encodeBufferSize ?? 64 * 1024;
    this._encodeBuffer = new Uint8Array(encodeBufferSize);
    this._disconnectGraceMs = options.disconnectGraceMs ?? 10_000;
    this._trackerCache = new TrackerCache(this);
    this._components = this.networkComponents;
    ensureRegistered(this, Networked);
    ensureRegistered(this, NetworkClient);
    ensureRegistered(this, NetworkInput);
    ensureRegistered(this, View);
    ensureRegistered(this, ServerClientSession);
  }

  /** @internal */
  public _attach(listener: VecsSocketListener): void {
    listener.on("new", (socket) => this._onNewConnection(socket));
  }

  public handleRpc(rpcId: number, handler: RPCHandler): void {
    this._rpcHandlers.set(rpcId, handler);
    this._sessions.forEach((session) => session.rpc.listen(rpcId, handler));
  }

  public installSystems(options: InstallSystemsOptions = {}): void {
    if (this._systemsInstalled) {
      return;
    }
    this._systemsInstalled = true;
    const collectPhase = this._phaseTarget(options.collectPhase ?? PRE_STORE);
    const sendPhase = this._phaseTarget(options.sendPhase ?? ON_STORE);

    this.component(Networked).onRemove((entity) => {
      this._record(entity, ALL_COMPONENTS, undefined);
    });
    this.component(ServerClientSession).onRemove((_entity, session) => {
      session.destroy();
    });

    this._clients = this.system(`ServerWorld:${this.name}:View`)
      .with(View, ServerClientSession)
      .phase(collectPhase)
      .update(View, [ServerClientSession], (_entity, view, [_session]) => {
        view._refreshTracker(this._trackerCache);
      })
      .exit([View, ServerClientSession], (_entity, [view, _session]) => {
        view._releaseTrackers(this._trackerCache);
      })
      .track();
    this._components.forEach((registered) => {
      this.system(`ServerWorld:${this.name}:${registered.Class.name}`)
        .with(Networked, registered.Class)
        .phase(collectPhase)
        .update(registered.Class, (entity, component) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.type));
          this._record(entity, registered.type, component);
        })
        .exit((entity) => {
          this._snapshotCache.delete(cid_pack(entity.eid, registered.type));
          this._record(entity, registered.type, undefined);
        })
        .track();
    });

    this.system(`ServerWorld:${this.name}:Send`)
      .phase(sendPhase)
      .run(() => this.send());
  }

  public send(): void {
    const toFrame = this._frame++;
    if (this._sessions.size === 0) {
      this._updates.clear();
      return;
    }

    const nowMs = performance.now();
    const staleSessions: ServerClientSession[] = [];

    this._clients.forEach([View, ServerClientSession], (e, [view, session]) => {
      view._reconcileVisibility();
      view._releaseOldTracker(this._trackerCache);

      if (session.ackFrame < toFrame - HISTORY_LENGTH) {
        session.needsFullSnapshot = true;
        session.needsResync = true;
      }
      if (session.needsResync) {
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
          snapshots.push(this._encodeSnapshot(u.entity.eid, u.type, u.component));
        } else {
          removed.push([u.entity.eid, u.type]);
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
      let diff: StateDiff;
      if (session.needsResync) {
        diff = new StateDiff({
          fromFrame: 0,
          toFrame,
          snapshots: latest.snapshots,
          removed: latest.removed,
        });
      } else {
        diff = session.history.pull(session.ackFrame, toFrame);
        if (session.needsFullSnapshot && diff.fromFrame !== 0) {
          diff = new StateDiff({
            fromFrame: 0,
            toFrame: diff.toFrame,
            snapshots: diff.snapshots,
            removed: diff.removed,
          });
        }
      }

      if (diff.snapshots.length === 0 && diff.removed.length === 0 && rpc.length === 0) {
        return;
      }
      session.socket.send(this._encode(new Server2Client({ diff, rpc })));
    });

    staleSessions.forEach((session) => session.socket.close());

    this._updates.clear();
  }

  private _onNewConnection(socket: VecsSocket): void {
    const entity = this.entity().add(Networked).add(NetworkClient).add(View);
    const session = new ServerClientSession(this._frame - 1);
    session.socket = socket;
    session.entity = entity;
    session.lastSeenMs = performance.now();
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
    session.lastSeenMs = performance.now();
    const message = new Decoder(data).read(Client2Server);
    if (message.ackFrame <= session.history.lastFrame) {
      session.ackFrame = Math.max(session.ackFrame, message.ackFrame);
      if (session.ackFrame > session.baseFrame) {
        session.needsFullSnapshot = false;
        session.needsResync = false;
      }
    }
    if (message.input !== undefined) {
      session.entity.set(NetworkInput, { input: message.input });
    }
    if (message.rpc.length > 0) {
      session.rpc.process(message.rpc);
    }
  }

  private _record(entity: Entity, type: number, component: ComponentInstance | undefined): void {
    this._updates.set(cid_pack(entity.eid, type), { entity, type, component });
  }

  private _phaseTarget(phase: string | Entity): Entity {
    return (typeof phase === "string" ? this.entity(phase) : this.entity(phase)).add(Phase);
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

  private _encodeSnapshot(eid: EID, type: number, component: ComponentInstance): EncodedSnapshot {
    const cid = cid_pack(eid, type);
    const cached = this._snapshotCache.get(cid);
    if (cached) {
      return cached;
    }

    const payloadEncoder = new Encoder(this._encodeBuffer);
    payloadEncoder.write(component);
    const payload = payloadEncoder.getBuffer().slice();
    const snapshot = new EncodedSnapshot(
      this._encode(new ComponentSnapshot({ eid, type, payload })),
      eid,
      type
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
