import { describe, expect, it } from "vitest";
import { type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder, type as wireType } from "@vworlds/vecs-wire";
import { World } from "@vworlds/vecs";
import { ComponentSnapshot, Server2Client } from "@vworlds/vecs-protocol";
import { Networked, VecsServerWorld } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class LocalOnly {
  public value = 0;
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

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

describe("VecsServerWorld", () => {
  it("sends full component snapshots for networked component updates", () => {
    const world = new World();
    world.registerComponent(Networked);
    world.registerComponent(Position, 1);
    world.registerComponent(LocalOnly);
    const server = new VecsServerWorld("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    server.addSocket(socket);
    server.installSystems();

    const entity = world.entity();
    entity.add(Networked).set(Position, { x: 10, y: 20 }).set(LocalOnly, { value: 5 });
    world.start();
    world.progress(0, 16);

    const message = new Decoder(socket.sent[0]).read(Server2Client);
    const snapshot = new Decoder(message.diff!.snapshots[0]).read(ComponentSnapshot);
    const position = new Decoder(snapshot.payload).read(Position);

    expect(snapshot.eid).toBe(entity.eid);
    expect(snapshot.type).toBe(1);
    expect(position).toMatchObject({ x: 10, y: 20 });
    expect(message.diff!.removed).toEqual([]);
  });

  it("sends component removals when a synchronized component exits", () => {
    const world = new World();
    world.registerComponent(Networked);
    world.registerComponent(Position, 1);
    const server = new VecsServerWorld("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    server.addSocket(socket);
    server.installSystems();
    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.start();
    world.progress(0, 16);

    entity.remove(Position);
    world.progress(16, 16);

    const message = new Decoder(socket.sent[1]).read(Server2Client);
    expect(message.diff!.removed).toEqual([{ eid: entity.eid, type: 1 }]);
    expect(message.diff!.snapshots).toEqual([]);
  });

  it("sends current networked state to late-joining clients", () => {
    const world = new World();
    world.registerComponent(Networked);
    world.registerComponent(Position, 1);
    const server = new VecsServerWorld("main", world);
    server.registerComponent(Position);
    server.installSystems();
    const entity = world.entity().add(Networked).set(Position, { x: 30, y: 40 });
    world.start();
    world.progress(0, 16);

    const socket = new MemorySocket("client-1");
    server.addSocket(socket);
    server.flush();

    const message = new Decoder(socket.sent[0]).read(Server2Client);
    const snapshot = new Decoder(message.diff!.snapshots[0]).read(ComponentSnapshot);
    expect(snapshot.eid).toBe(entity.eid);
    expect(new Decoder(snapshot.payload).read(Position)).toMatchObject({ x: 30, y: 40 });
  });
});
