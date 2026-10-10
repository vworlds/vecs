import { type Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Motion,
  MotionClock,
  Position,
  Rotation,
  phaserMotionComponents,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import {
  Server2Client,
  StateDiff,
  type EncodedSnapshot,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder } from "@vworlds/vecs-wire";
import { afterEach, describe, expect, it } from "vitest";

import { DeadReckonedModule } from "../../src/modules/dead_reckoned.js";
import { phaserInterpolators } from "../../src/sync.js";
import { BODY, removeOnWire, setOnWire } from "./dead_reckoned_fixtures.js";

const worlds: ClientWorld[] = [];
afterEach(() => worlds.splice(0).forEach((world) => world.dispose()));

describe("packet-buffered DR hand-off ownership", () => {
  it("fades to a constant target across several render pulls per tick", () => {
    const { world, body, send } = setup();
    send(3, pose(0.25, 0.25));
    for (const frame of [2, 2.25, 2.5, 2.75]) {
      world.progress(10 + (frame - 2) * 10, 2.5);
      expect(world.renderFrame).toBe(frame);
      const expected = (0.25 * (frame - 2) * 10) / 100;
      expect(body.get(Position)!.x).toBeCloseTo(expected, 6);
      expect(body.get(Rotation)!.angle).toBeCloseTo(expected, 6);
    }
  });

  it("follows a moving streamed position and angle without corrupting network sources", () => {
    const { world, body, send } = setup();
    for (let frame = 2; frame <= 5.75; frame += 0.25) {
      if (Number.isInteger(frame)) {
        send(frame + 1, pose(0.25 + (frame - 1) * 0.125, 0.25 + (frame - 1) * 0.0625));
      }
      world.progress(10 + (frame - 2) * 10, 2.5);
      expect(world.renderFrame).toBe(frame);
      const left = 1 - ((frame - 2) * 10) / 100;
      expect(body.get(Position)!.x).toBeCloseTo(0.25 + (frame - 2) * 0.125 - 0.25 * left, 6);
      expect(body.get(Rotation)!.angle).toBeCloseTo(0.25 + (frame - 2) * 0.0625 - 0.25 * left, 6);
    }
  });

  it("retains its output when no snapshot arrives and completes at the exact source pose", () => {
    const { world, body, send } = setup();
    world.progress(10, 10);
    expect(body.get(Position)!.x).toBe(0);
    expect(body.get(Rotation)!.angle).toBe(0);
    const position = body.get(Position);
    const rotation = body.get(Rotation);
    send(3, []);
    world.progress(15, 5);
    expect(world.renderFrame).toBe(2.5);
    expect(body.get(Position)).toBe(position);
    expect(body.get(Rotation)).toBe(rotation);
    expect(body.get(Position)!.x).toBeCloseTo(0.0125, 6);
    expect(body.get(Rotation)!.angle).toBeCloseTo(0.0125, 6);
    for (let frame = 4; frame <= 13; frame++) {
      send(frame, []);
    }
    world.progress(109, 94);
    expect(world.renderFrame).toBe(13);
    expect(body.get(Position)!.x).toBeCloseTo(0.2475, 6);
    expect(trackOf(body)).not.toBeUndefined();
    world.progress(110, 1);
    expect(body.get(Position)).toBe(position);
    expect(body.get(Rotation)).toBe(rotation);
    expect(body.get(Position)!.x).toBe(0.25);
    expect(body.get(Rotation)!.angle).toBe(0.25);
    expect(trackOf(body)).toBeUndefined();
    send(14, pose(0.5, 0.5));
    world.progress(150, 40);
    expect(body.get(Position)).not.toBe(position);
    expect(body.get(Position)!.x).toBe(0.5);
    expect(body.get(Rotation)!.angle).toBe(0.5);
  });

  it("starts a reversed DR track from the shown hand-off pose", () => {
    const { world, body, send } = setup();
    world.progress(10, 10);
    send(3, []);
    world.progress(15, 5);
    const x = body.get(Position)!.x;
    const angle = body.get(Rotation)!.angle;
    const handoff = trackOf(body);
    send(
      4,
      [setOnWire(BODY, Motion, { frame: 4, x: 0.5, angle: 0.5, rest: true })],
      [removeOnWire(BODY, Position), removeOnWire(BODY, Rotation)]
    );
    world.progress(30, 15);
    expect(world.renderFrame).toBe(4);
    expect(body.has(Motion)).toBe(true);
    expect(trackOf(body)).not.toBe(handoff);
    expect(body.get(Position)!.x).toBe(x);
    expect(body.get(Rotation)!.angle).toBe(angle);
  });

  it("snaps immediately with blendMs zero", () => {
    const { world, body } = setup(0);
    world.progress(10, 10);
    expect(body.get(Position)!.x).toBe(0.25);
    expect(body.get(Rotation)!.angle).toBe(0.25);
    expect(trackOf(body)).toBeUndefined();
  });
});

function setup(blendMs = 100) {
  const socket = new MemorySocket();
  const world = new ClientWorld({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    interpolators: phaserInterpolators(),
    serverTickIntervalMs: 10,
    ackIntervalMs: 1e9,
    socket,
  });
  worlds.push(world);
  world.module(DeadReckonedModule, { blendMs });
  const send = (frame: number, snapshots: EncodedSnapshot[], removed: [number, number][] = []) => {
    const encoder = new Encoder(new Uint8Array(65536));
    encoder.write(
      new Server2Client({
        diff: new StateDiff({ fromFrame: frame - 1, toFrame: frame, snapshots, removed }),
      })
    );
    socket.receive(encoder.getBuffer().slice());
  };
  send(1, [
    setOnWire(1001, MotionClock, { stepSeconds: 0.01 }),
    setOnWire(BODY, Motion, { frame: 1, rest: true }),
  ]);
  world.progress(0, 10);
  send(2, pose(0.25, 0.25), [removeOnWire(BODY, Motion)]);
  return { world, body: world.entity(BODY), send };
}

function pose(x: number, angle: number): EncodedSnapshot[] {
  return [setOnWire(BODY, Position, { x }), setOnWire(BODY, Rotation, { angle })];
}

function trackOf(entity: Entity): object | undefined {
  let track: object | undefined;
  entity.components.forEach((component) => {
    if (component.constructor.name === "MotionTrack") {
      track = component;
    }
  });
  return track;
}

type SocketHandler = (arg?: unknown) => void;
class MemorySocket implements VecsSocket {
  public readonly id = "handoff";
  private readonly _handlers = new Map<string, SocketHandler[]>();
  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
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
