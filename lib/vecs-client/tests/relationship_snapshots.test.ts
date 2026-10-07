import { describe, expect, it } from "vitest";
import {
  ALL_COMPONENTS,
  ComponentSnapshot,
  EncodedSnapshot,
  encodeRelationshipSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import { ChildOf, Exclusive, Relationship, type ComponentClass, type EID } from "@vworlds/vecs";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  ClientWorld,
  type ClientWorldDisconnectEvent,
} from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class WeightedLink extends Relationship {
  @wireType("i32")
  public weight = 0;
}

class ExclusiveLink extends Relationship {}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encodeComponent(component: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(component);
  return encoder.getBuffer();
}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

function makeSnapshot(eid: EID, wireType: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

function posSnapshot(eid: EID, x: number, y: number): EncodedSnapshot {
  const p = new Position();
  p.x = x;
  p.y = y;
  return makeSnapshot(eid, 1, encodeComponent(p));
}

function relationshipSnapshot<R extends Relationship>(
  eid: EID,
  Class: ComponentClass<R>,
  targetEids: EID[],
  values?: Partial<R>
): EncodedSnapshot {
  const relationship = Object.assign(new Class(), values);
  const encoder = new Encoder(new Uint8Array(1024));
  encodeRelationshipSnapshot(encoder, targetEids, relationship);
  return makeSnapshot(eid, 2, encoder.getBuffer());
}

function childOfSnapshot(eid: EID, targetEid: EID): EncodedSnapshot {
  return relationshipSnapshot(eid, ChildOf, [targetEid]);
}

// These tests use [Position, ChildOf] (2 components, localComponentMin = 4).
// Separate file so the global localComponentMin doesn't conflict with the
// existing client tests that use [Position] (localComponentMin = 2).
describe("ClientWorld relationship snapshots", () => {
  it("reconciles many targets, creates every ghost, and applies ordinary fields", () => {
    const world = new ClientWorld({
      networkComponents: [Position, WeightedLink],
      serverTickIntervalMs: 10,
    });
    let addCount = 0;
    let removeCount = 0;
    world
      .component(WeightedLink)
      .on("add", () => addCount++)
      .on("remove", () => removeCount++);
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [
              posSnapshot(1000, 1, 1),
              relationshipSnapshot(1000, WeightedLink, [1001, 1002, 1003], { weight: 7 }),
            ],
          }),
        })
      )
    );
    world.progress(0, 0);

    const source = world.getEntity(1000)!;
    expect(
      [...source.targets(WeightedLink)].map((target) => target.eid).sort((a, b) => a - b)
    ).toEqual([1001, 1002, 1003]);
    expect(source.get(WeightedLink)).toMatchObject({ weight: 7 });
    expect(world.getEntity(1001)).toBeDefined();
    expect(world.getEntity(1002)).toBeDefined();
    expect(world.getEntity(1003)).toBeDefined();
    expect(addCount).toBe(1);
    expect(removeCount).toBe(0);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            snapshots: [relationshipSnapshot(1000, WeightedLink, [1002, 1004], { weight: 11 })],
          }),
        })
      )
    );
    world.progress(20, 20);

    expect(
      [...source.targets(WeightedLink)].map((target) => target.eid).sort((a, b) => a - b)
    ).toEqual([1002, 1004]);
    expect(source.hasTarget(WeightedLink, world.getEntity(1001)!)).toBe(false);
    expect(source.hasTarget(WeightedLink, world.getEntity(1002)!)).toBe(true);
    expect(source.get(WeightedLink)).toMatchObject({ weight: 11 });
    expect(addCount).toBe(1);
    expect(removeCount).toBe(0);
  });

  it("closes the client on an Exclusive relationship payload with multiple targets", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ExclusiveLink],
      serverTickIntervalMs: 10,
    });
    world.component(ExclusiveLink).add(Exclusive);
    const disconnects: Array<ClientWorldDisconnectEvent | undefined> = [];
    world.events.on("disconnect", (event) => disconnects.push(event));
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [relationshipSnapshot(1000, ExclusiveLink, [1001, 1002])],
          }),
        })
      )
    );

    expect(() => world.progress(0, 0)).not.toThrow();

    expect(disconnects).toEqual([
      {
        code: CLOSE_PROTOCOL_ERROR_CODE,
        reason: "protocol error: Exclusive relationship ExclusiveLink snapshot has 2 targets",
      },
    ]);
    // The rejected snapshot created neither the source nor either target.
    expect(world.getEntity(1000)).toBeUndefined();
    expect(world.getEntity(1001)).toBeUndefined();
    expect(world.getEntity(1002)).toBeUndefined();
  });

  it("resolves a ChildOf snapshot when the parent already exists", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [
              posSnapshot(1000, 1, 1),
              posSnapshot(1001, 2, 2),
              childOfSnapshot(1001, 1000),
            ],
          }),
        })
      )
    );
    world.progress(0, 0);

    const child = world.getEntity(1001)!;
    const parent = world.getEntity(1000)!;
    expect(child.target(ChildOf)).toBe(parent);
  });

  it("creates a ghost target when the parent arrives after the child", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    // Child + ChildOf snapshot arrive first — parent doesn't exist yet.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1001, 2, 2), childOfSnapshot(1001, 1000)],
          }),
        })
      )
    );
    world.progress(0, 0);

    const child = world.getEntity(1001)!;
    // Ghost parent is created immediately — the relationship resolves right away.
    const ghost = world.getEntity(1000)!;
    expect(child.target(ChildOf)).toBe(ghost);
    // Ghost has Networked but no Position yet.
    expect(ghost.get(Position)).toBeUndefined();

    // Parent's real data arrives in a later frame — attaches to the same entity.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            snapshots: [posSnapshot(1000, 1, 1)],
          }),
        })
      )
    );
    world.progress(20, 20);

    const parent = world.getEntity(1000)!;
    expect(parent).toBe(ghost);
    expect(parent.get(Position)).toMatchObject({ x: 1, y: 1 });
    expect(child.target(ChildOf)).toBe(parent);
  });

  it("retargeting before the original target arrives does not leave stale links", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    // ChildOf → 1000 arrives, parent 1000 missing → ghost 1000 created.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1001, 2, 2), childOfSnapshot(1001, 1000)],
          }),
        })
      )
    );
    world.progress(0, 0);

    const child = world.getEntity(1001)!;
    expect(child.target(ChildOf)).toBe(world.getEntity(1000)!);

    // Retarget: ChildOf → 1002 arrives, parent 1002 also missing → ghost 1002 created.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            snapshots: [childOfSnapshot(1001, 1002)],
          }),
        })
      )
    );
    world.progress(20, 20);

    expect(child.target(ChildOf)).toBe(world.getEntity(1002)!);

    // Original target 1000 arrives — must NOT overwrite the retargeted link.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 2,
            toFrame: 3,
            snapshots: [posSnapshot(1000, 1, 1)],
          }),
        })
      )
    );
    world.progress(40, 20);

    expect(child.target(ChildOf)).toBe(world.getEntity(1002)!);
  });

  it("child destroyed before the target arrives leaves no stale resolution", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    // ChildOf → 1000 arrives, parent 1000 missing → ghost 1000 created.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1001, 2, 2), childOfSnapshot(1001, 1000)],
          }),
        })
      )
    );
    world.progress(0, 0);

    expect(world.getEntity(1001)!.target(ChildOf)).toBe(world.getEntity(1000)!);

    // Child is destroyed before parent 1000 ever arrives.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            removed: [[1001, ALL_COMPONENTS]],
          }),
        })
      )
    );
    world.progress(20, 20);

    expect(world.getEntity(1001)).toBeUndefined();

    // Parent 1000 arrives — no crash, no stale resolution.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 2,
            toFrame: 3,
            snapshots: [posSnapshot(1000, 1, 1)],
          }),
        })
      )
    );
    expect(() => world.progress(40, 20)).not.toThrow();
    expect(world.getEntity(1000)!.get(Position)).toMatchObject({ x: 1, y: 1 });
  });

  it("removes a relationship when a component removal is received", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [
              posSnapshot(1000, 1, 1),
              posSnapshot(1001, 2, 2),
              childOfSnapshot(1001, 1000),
            ],
          }),
        })
      )
    );
    world.progress(0, 0);

    const child = world.getEntity(1001)!;
    expect(child.target(ChildOf)).toBeDefined();

    // Server sends a component removal for ChildOf (type 2).
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            removed: [[1001, 2]],
          }),
        })
      )
    );
    world.progress(20, 20);

    expect(child.target(ChildOf)).toBeUndefined();
  });

  it("survives a baseline reset clearing ghost entities", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    // Child arrives with a ChildOf to a parent that never comes.
    // A ghost entity 9999 is created to hold the link.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1001, 2, 2), childOfSnapshot(1001, 9999)],
          }),
        })
      )
    );
    world.progress(0, 0);
    expect(world.getEntity(1001)!.target(ChildOf)).toBe(world.getEntity(9999)!);

    // Baseline reset: destroy everything (including the ghost) and recreate.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 2,
            snapshots: [posSnapshot(2000, 5, 5)],
          }),
        })
      )
    );
    expect(() => world.progress(32, 16)).not.toThrow();
    expect(world.getEntity(2000)!.get(Position)).toMatchObject({ x: 5, y: 5 });
  });
});
