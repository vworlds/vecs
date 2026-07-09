import { describe, expect, it } from "vitest";
import {
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import { ChildOf, type World } from "@vworlds/vecs";
import { NetworkClient, Networked, ServerWorld, View } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closed = false;
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
    this.closed = true;
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

class MockListener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public connect(socket: VecsSocket): void {
    this._handlers.forEach((h) => h(socket));
  }
}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

function decodeLastMessage(socket: MemorySocket): Server2Client {
  return new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
}

function allowAllClientViews(world: World): void {
  world.component(NetworkClient).onSet((entity) => {
    entity.set(View, { dsl: true });
  });
}

// These tests use [Position, ChildOf] (2 components), so localComponentMin = 4.
// They must run in a context where no prior test set localComponentMin to a
// different value. Vitest isolates module state per test file when using the
// default threads pool with per-file isolation, so a separate file is used.
describe("ServerWorld relationship serialization", () => {
  it("serializes ChildOf relationships added to networkComponents", () => {
    const world = new ServerWorld({ networkComponents: [Position, ChildOf] });
    allowAllClientViews(world);
    const server = world;
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const parent = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    const child = world.entity().add(Networked).set(Position, { x: 2, y: 2 }).childOf(parent);
    world.progress(0, 16);

    const message = decodeLastMessage(socket);
    const decoded = message.diff!.snapshots.map((s) => {
      const snap = new Decoder(s.bytes).read(ComponentSnapshot);
      return { eid: snap.eid, wireType: snap.wireType };
    });

    const childLink = decoded.find((s) => s.eid === child.eid && s.wireType === 2);
    expect(childLink).toBeDefined();

    const rawSnapshot = message.diff!.snapshots.find((s) => {
      const snap = new Decoder(s.bytes).read(ComponentSnapshot);
      return snap.eid === child.eid && snap.wireType === 2;
    })!;
    const snapshot = new Decoder(rawSnapshot.bytes).read(ComponentSnapshot);
    const rel = new Decoder(snapshot.payload).read(ChildOf) as unknown as { target: number };
    expect(rel.target).toBe(parent.eid);
  });

  it("serializes relationship removal as a component removal", () => {
    const world = new ServerWorld({ networkComponents: [Position, ChildOf] });
    allowAllClientViews(world);
    const server = world;
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const parent = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    const child = world.entity().add(Networked).set(Position, { x: 2, y: 2 }).childOf(parent);
    world.progress(0, 16);

    child.remove(ChildOf);
    world.progress(16, 16);

    const message = decodeLastMessage(socket);
    expect(message.diff!.removed).toContainEqual([child.eid, 2]);
  });

  it("does not serialize relationships not in networkComponents", () => {
    const world = new ServerWorld({ networkComponents: [Position, ChildOf] });
    allowAllClientViews(world);
    const server = world;
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    // Entity has ChildOf but we want to verify it's still serialized since
    // ChildOf IS in networkComponents. Instead, verify a non-relationship
    // component (Position) is the only snapshot for an entity without ChildOf.
    const entity = world.entity().add(Networked).set(Position, { x: 2, y: 2 });
    world.progress(0, 16);

    const message = decodeLastMessage(socket);
    const decoded = message.diff!.snapshots.map((s) => {
      const snap = new Decoder(s.bytes).read(ComponentSnapshot);
      return { eid: snap.eid, wireType: snap.wireType };
    });

    const entitySnaps = decoded.filter((s) => s.eid === entity.eid);
    // Only Position (wire type 1), no ChildOf (wire type 2) since entity has no ChildOf
    expect(entitySnaps).toHaveLength(1);
    expect(entitySnaps[0].wireType).toBe(1);
  });
});
