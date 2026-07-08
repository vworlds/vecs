import { describe, expect, it } from "vitest";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, type as wireType } from "@vworlds/vecs-wire";
import { ChildOf, type EID } from "@vworlds/vecs";
import { ClientWorld } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

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

function makeSnapshot(eid: EID, type: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, type, payload })),
    eid,
    type
  );
}

function posSnapshot(eid: EID, x: number, y: number): EncodedSnapshot {
  const p = new Position();
  p.x = x;
  p.y = y;
  return makeSnapshot(eid, 1, encodeComponent(p));
}

function childOfSnapshot(eid: EID, targetEid: EID): EncodedSnapshot {
  const rel = new ChildOf();
  (rel as unknown as { target: { eid: number } }).target = { eid: targetEid };
  return makeSnapshot(eid, 2, encodeComponent(rel));
}

// These tests use [Position, ChildOf] (2 components, localComponentMin = 4).
// Separate file so the global localComponentMin doesn't conflict with the
// existing client tests that use [Position] (localComponentMin = 2).
describe("ClientWorld relationship snapshots", () => {
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

  it("defers resolution when the parent arrives after the child", () => {
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
    expect(child.target(ChildOf)).toBeUndefined();

    // Parent arrives in a later frame.
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
    expect(child.target(ChildOf)).toBe(parent);
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

  it("survives a baseline reset clearing pending relationships", () => {
    const world = new ClientWorld({
      networkComponents: [Position, ChildOf],
      serverTickIntervalMs: 10,
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    // Child arrives with a ChildOf to a parent that never comes.
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
    expect(world.getEntity(1001)!.target(ChildOf)).toBeUndefined();

    // Baseline reset: destroy everything and recreate.
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
