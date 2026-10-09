import { describe, expect, it } from "vitest";
import {
  ALL_COMPONENTS,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  CLOSE_PROTOCOL_ERROR_CODE,
  type RemovedComponent,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import type { EID, Entity } from "@vworlds/vecs";
import { ClientWorld } from "../src/index.js";

// The server reuses the id of a destroyed entity, and the wire carries no entity generation. A
// diff that removes all of an eid (ALL_COMPONENTS) and snapshots the same eid is telling the
// client that the entity it holds is gone and a new one has its id: `apply` destroys first, then
// applies the snapshots, then removes single components. These tests drive a ClientWorld through
// that handover, both by calling `apply()` and through `progress()`, where the whole of `apply`
// runs inside a system and the destruction only takes effect at the flush after it.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class Health {
  @wireType("i32")
  public hp = 0;
}

/** Client-local, never replicated: stands for a sprite or any state a game hangs on an entity. */
class LocalMark {
  public tag = "";
}

const POSITION = 1;
const HEALTH = 2;
const A = 1000;
const OTHER = 1001;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(): void {}

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encode(value: IEncodable | object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(value as IEncodable);
  return encoder.getBuffer();
}

function snapshot(eid: EID, type: number, component: object): EncodedSnapshot {
  return new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType: type, payload: encode(component) })),
    eid,
    type
  );
}

function position(eid: EID, x: number, y: number): EncodedSnapshot {
  return snapshot(eid, POSITION, Object.assign(new Position(), { x, y }));
}

function health(eid: EID, hp: number): EncodedSnapshot {
  return snapshot(eid, HEALTH, Object.assign(new Health(), { hp }));
}

/** A snapshot of a wire type the client did not register, which it cannot decode. */
function undecodable(eid: EID): EncodedSnapshot {
  return new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType: 3, payload: new Uint8Array([1]) })),
    eid,
    3
  );
}

function deliver(
  socket: MemorySocket,
  fromFrame: number,
  toFrame: number,
  changes: { snapshots?: EncodedSnapshot[]; removed?: RemovedComponent[] } = {}
): void {
  socket.receive(
    encode(new Server2Client({ diff: new StateDiff({ fromFrame, toFrame, ...changes }) }))
  );
}

/** Two ways to run the world: `apply()` outside any scope, and `progress()` through its system. */
const DRIVERS: ReadonlyArray<readonly [string, (world: ClientWorld, now: number) => void]> = [
  ["apply()", (world, now) => world.apply(now)],
  ["progress()", (world, now) => world.progress(now, 16)],
];

interface Setup {
  world: ClientWorld;
  socket: MemorySocket;
  /** How many times a Position was attached to an entity. */
  positionAdds: EID[];
  /** How many times an entity with a Position entered the world, by eid. */
  enters: EID[];
  disconnects: Array<{ code?: number } | undefined>;
}

/** A client holding entity A (Position, Health) with a client-local mark, and an unrelated entity. */
function clientHoldingA(drive: (world: ClientWorld, now: number) => void): Setup {
  const world = new ClientWorld({
    networkComponents: [Position, Health],
    serverTickIntervalMs: 10,
  });
  world.component(LocalMark);
  const positionAdds: EID[] = [];
  const enters: EID[] = [];
  world.component(Position).on("add", (entity) => positionAdds.push(entity.eid));
  world
    .query("entity-reuse:positioned")
    .with(Position)
    .enter((entity) => enters.push(entity.eid))
    .build();
  const disconnects: Setup["disconnects"] = [];
  world.events.on("disconnect", (notice) => disconnects.push(notice));
  const socket = new MemorySocket("server");
  world.attachSocket(socket);

  deliver(socket, 0, 1, {
    snapshots: [position(A, 1, 2), health(A, 55), position(OTHER, 7, 7), health(OTHER, 70)],
  });
  drive(world, 0);
  world.entity(A).set(LocalMark, { tag: "sprite of A" });
  return { world, socket, positionAdds, enters, disconnects };
}

function componentsOf(entity: Entity): {
  position: { x: number; y: number } | undefined;
  health: number | undefined;
  mark: string | undefined;
} {
  const p = entity.get(Position);
  return {
    position: p === undefined ? undefined : { x: p.x, y: p.y },
    health: entity.get(Health)?.hp,
    mark: entity.get(LocalMark)?.tag,
  };
}

describe.each(DRIVERS)(
  "a diff that removes an eid and snapshots it again, applied by %s",
  (_, drive) => {
    it("destroys the entity it held and builds a new one from the snapshots", () => {
      const { world, socket } = clientHoldingA(drive);
      const old = world.entity(A);

      deliver(socket, 1, 2, { removed: [[A, ALL_COMPONENTS]], snapshots: [position(A, 9, 9)] });
      drive(world, 10);

      const fresh = world.entity(A);
      expect(fresh).not.toBe(old);
      expect(old.destroyed).toBe(true);
      expect(fresh.destroyed).toBe(false);
    });

    it("leaves none of the old entity's components on the new one, replicated or client-local", () => {
      const { world, socket } = clientHoldingA(drive);

      deliver(socket, 1, 2, { removed: [[A, ALL_COMPONENTS]], snapshots: [position(A, 9, 9)] });
      drive(world, 10);

      expect(componentsOf(world.entity(A))).toEqual({
        position: { x: 9, y: 9 },
        health: undefined,
        mark: undefined,
      });
    });

    it("fires the add hook and the enter event for the new entity", () => {
      const { world, socket, positionAdds, enters } = clientHoldingA(drive);
      expect(positionAdds.filter((eid) => eid === A)).toHaveLength(1);
      expect(enters.filter((eid) => eid === A)).toHaveLength(1);

      deliver(socket, 1, 2, { removed: [[A, ALL_COMPONENTS]], snapshots: [position(A, 9, 9)] });
      drive(world, 10);

      expect(positionAdds.filter((eid) => eid === A)).toHaveLength(2);
      expect(enters.filter((eid) => eid === A)).toHaveLength(2);
    });

    it("leaves the other entities as they were", () => {
      const { world, socket } = clientHoldingA(drive);
      const other = world.entity(OTHER);

      deliver(socket, 1, 2, { removed: [[A, ALL_COMPONENTS]], snapshots: [position(A, 9, 9)] });
      drive(world, 10);

      expect(world.entity(OTHER)).toBe(other);
      expect(componentsOf(other)).toMatchObject({ position: { x: 7, y: 7 }, health: 70 });
    });

    it("builds the new entity when the removal and the snapshots arrive in different diffs but are applied together", () => {
      const { world, socket } = clientHoldingA(drive);
      const old = world.entity(A);

      deliver(socket, 1, 2, { removed: [[A, ALL_COMPONENTS]] });
      deliver(socket, 2, 3, { snapshots: [position(A, 4, 4)] });
      drive(world, 100); // the buffer merges both frames into one diff

      const fresh = world.entity(A);
      expect(fresh).not.toBe(old);
      expect(componentsOf(fresh)).toEqual({
        position: { x: 4, y: 4 },
        health: undefined,
        mark: undefined,
      });
    });

    it("does not let an earlier snapshot of the old entity reach the new one", () => {
      const { world, socket } = clientHoldingA(drive);

      deliver(socket, 1, 2, { snapshots: [health(A, 10)] }); // still the old entity
      deliver(socket, 2, 3, { removed: [[A, ALL_COMPONENTS]], snapshots: [position(A, 4, 4)] });
      drive(world, 100); // merged into one diff

      expect(componentsOf(world.entity(A))).toEqual({
        position: { x: 4, y: 4 },
        health: undefined,
        mark: undefined,
      });
    });

    it("applies the removals of single components after the snapshots, to the same entity", () => {
      const { world, socket } = clientHoldingA(drive);
      const held = world.entity(A);

      deliver(socket, 1, 2, { snapshots: [position(A, 5, 5)], removed: [[A, HEALTH]] });
      drive(world, 10);

      expect(world.entity(A)).toBe(held);
      expect(componentsOf(held)).toEqual({
        position: { x: 5, y: 5 },
        health: undefined,
        mark: "sprite of A",
      });
    });

    it("builds the new entity without a component a later frame of the same pull removed from it", () => {
      const { world, socket } = clientHoldingA(drive);

      deliver(socket, 1, 2, {
        removed: [[A, ALL_COMPONENTS]],
        snapshots: [position(A, 6, 6), health(A, 1)],
      });
      deliver(socket, 2, 3, { removed: [[A, HEALTH]] });
      drive(world, 100); // the buffer merges both frames into one diff

      expect(componentsOf(world.entity(A))).toEqual({
        position: { x: 6, y: 6 },
        health: undefined,
        mark: undefined,
      });
    });

    it("creates the entity when the diff removes an eid the client never held", () => {
      const { world, socket } = clientHoldingA(drive);
      const newcomer = 1005;

      deliver(socket, 1, 2, {
        removed: [[newcomer, ALL_COMPONENTS]],
        snapshots: [position(newcomer, 3, 3)],
      });
      drive(world, 10);

      expect(componentsOf(world.entity(newcomer))).toMatchObject({ position: { x: 3, y: 3 } });
    });

    it("destroys the entity and applies nothing of the snapshots that cannot be decoded", () => {
      const { world, socket, disconnects } = clientHoldingA(drive);

      deliver(socket, 1, 2, {
        removed: [
          [A, ALL_COMPONENTS],
          [OTHER, HEALTH],
        ],
        snapshots: [position(A, 9, 9), undecodable(A)],
      });
      drive(world, 10);

      // The removal of the whole entity comes first and stays applied; the snapshot before the bad
      // one is applied; the removal of a single component, which comes last, is dropped.
      expect(componentsOf(world.entity(A))).toMatchObject({ position: { x: 9, y: 9 } });
      expect(componentsOf(world.entity(OTHER))).toMatchObject({ health: 70 });
      expect(disconnects).toHaveLength(1);
      expect(disconnects[0]?.code).toBe(CLOSE_PROTOCOL_ERROR_CODE);
    });
  }
);

describe("the id pools of a ClientWorld", () => {
  it("free the ids of replicated entities at once, and keep the default wait for local ones", () => {
    const world = new ClientWorld({ networkComponents: [Position, Health] });

    const waits = Object.fromEntries(world.pools.map((pool) => [pool.name, pool.reuseWaitFrames]));

    // The server decides when a replicated id comes back, so the client never holds one.
    expect(waits["network_entity"]).toBe(0);
    expect(waits["entity"]).toBeUndefined();
  });
});
