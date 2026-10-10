// Shared fixtures for the client extrapolator's tests: a ClientWorld with dead reckoning whose
// `renderFrame` the test sets, optionally fed server frames over a memory socket, and the reference
// path a baseline follows.

import type { ComponentClass, Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Motion,
  MotionClock,
  MotionParams,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  phaserMotionComponents,
  phaserNetworkComponents,
  stepMotion,
} from "@vworlds/vecs-phaser";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { vi } from "vitest";

import { DeadReckonedModule, PhaserRenderModule } from "../../src/index.js";
import type { DeadReckonedModuleConfig } from "../../src/index.js";
import { createMockScene } from "../mock_phaser.js";
import { PPM, SCENE_HEIGHT, SCENE_WIDTH } from "./parenting_fixtures.js";

const NETWORK_COMPONENTS = [...phaserNetworkComponents, ...phaserMotionComponents];

export const CLOCK: Partial<MotionClock> = {
  stepSeconds: Math.fround(1 / 30),
  subSteps: 4,
  gravityX: 0,
  gravityY: 0,
  maxLinearSpeed: 400,
};

/** A drifting, spinning body. Its entity carries `DAMPING` as its `MotionParams`. */
export const DRIFT: Partial<Motion> = {
  frame: 10,
  x: 1,
  y: 2,
  angle: 0.25,
  vx: 3,
  vy: -1,
  w: 0.5,
};

/** The body constants of a damped body whose center of mass is off its origin. */
export const DAMPING: Partial<MotionParams> = {
  linearDamping: 0.15,
  angularDamping: 0.1,
  localCenterX: 0.4,
  localCenterY: -0.2,
};

/** The entity id the server gives the bodies that `Client.send` feeds; client-local ids are above. */
export const BODY = 1000;

/** The wire type of a network component. */
export function wireTypeOf(Class: ComponentClass): number {
  return NETWORK_COMPONENTS.indexOf(Class) + 1;
}

/** A snapshot that sets `Class` on entity `eid`, as a server frame carries it. */
export function setOnWire(eid: number, Class: ComponentClass, value: object): EncodedSnapshot {
  const wireType = wireTypeOf(Class);
  const payload = encode(Object.assign(new Class(), value));
  return new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

/** A removal of `Class` from entity `eid`, as a server frame carries it. */
export function removeOnWire(eid: number, Class: ComponentClass): [number, number] {
  return [eid, wireTypeOf(Class)];
}

/**
 * A ClientWorld with dead reckoning and a `renderFrame` the test sets. With `wire`, it also takes
 * server frames through {@link Client.send}, which `render` applies like any frame.
 */
export class Client {
  public readonly world: ClientWorld;
  /** The entity that carries the world's `MotionClock`. */
  public readonly clockEntity: Entity;
  public frame = 0;
  private readonly _socket: MemorySocket | undefined;
  private _serverFrame = 0;
  private _now = 0;

  public constructor(config?: DeadReckonedModuleConfig, render = false, wire = false) {
    this.world = new ClientWorld({
      networkComponents: NETWORK_COMPONENTS,
      // A ClientWorld that is fed frames never fires its own ack timer.
      ...(wire ? { serverTickIntervalMs: TICK_MS, ackIntervalMs: 1e9 } : {}),
    });
    vi.spyOn(this.world, "renderFrame", "get").mockImplementation(() => this.frame);
    if (render) {
      // Installed first, so only the phase order can put the extrapolator ahead of it.
      const scene = createMockScene(SCENE_WIDTH, SCENE_HEIGHT);
      this.world.module(PhaserRenderModule, { scene, pixelsPerMeter: PPM });
    }
    this.world.module(DeadReckonedModule, config ?? {});
    this.clockEntity = this.world.entity().set(MotionClock, CLOCK);
    if (wire) {
      this._socket = new MemorySocket();
      this.world.attachSocket(this._socket);
    }
  }

  /** Hand the world the server's next frame; the next `render` applies it. */
  public send(snapshots: EncodedSnapshot[], removed: Array<[number, number]> = []): void {
    const fromFrame = this._serverFrame;
    this._serverFrame++;
    this._socket!.receive(
      encode(
        new Server2Client({
          diff: new StateDiff({ fromFrame, toFrame: this._serverFrame, snapshots, removed }),
        })
      )
    );
  }

  /** Render one frame at `renderFrame`. */
  public render(renderFrame: number): void {
    this.frame = renderFrame;
    this.world.progress(this._now, 16);
    this._now += 16;
  }
}

/**
 * The baseline's own path at `renderFrame`, sampled the way the extrapolator samples it, stepped
 * with `constants` (the body's `MotionParams`; the defaults when empty) in `CLOCK` adjusted by
 * `clockFields`.
 */
export function pathAt(
  baseline: Partial<Motion>,
  renderFrame: number,
  constants: Partial<MotionParams> = DAMPING,
  clockFields: Partial<MotionClock> = {}
): { x: number; y: number; angle: number } {
  const motion = Object.assign(new Motion(), baseline);
  const params = Object.assign(new MotionParams(), constants);
  const clock = Object.assign(new MotionClock(), CLOCK, clockFields);
  const elapsed = renderFrame - motion.frame;
  const steps = Math.floor(elapsed);
  const state = motionStateFrom(motion, params, new MotionState());
  for (let i = 0; i < steps; i++) {
    stepMotion(state, params, clock);
  }
  const from = motionPose(state, params, new MotionPose());
  stepMotion(state, params, clock);
  const to = motionPose(state, params, new MotionPose());
  const fraction = elapsed - steps;
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
    angle: from.angle + (to.angle - from.angle) * fraction,
  };
}

/**
 * A baseline on `baseline`'s path at whole frame `frame` for a body with `constants`, as the
 * server would send it.
 */
export function pathMotion(
  baseline: Partial<Motion>,
  frame: number,
  constants: Partial<MotionParams> = DAMPING
): Motion {
  const motion = Object.assign(new Motion(), baseline);
  const params = Object.assign(new MotionParams(), constants);
  const clock = Object.assign(new MotionClock(), CLOCK);
  const state = motionStateFrom(motion, params, new MotionState());
  for (let i = motion.frame; i < frame; i++) {
    stepMotion(state, params, clock);
  }
  const pose = motionPose(state, params, new MotionPose());
  return Object.assign(new Motion(), baseline, {
    frame,
    x: pose.x,
    y: pose.y,
    angle: pose.angle,
    vx: state.vx,
    vy: state.vy,
    w: state.w,
  });
}

/** Server tick interval of a fed `Client`, in milliseconds: short, so a frame sent after an idle render is applied by the next one. */
const TICK_MS = 1;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly id = "server";
  private readonly _handlers = new Map<string, SocketHandler[]>();

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

function encode(message: IEncodable | object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message as IEncodable);
  return encoder.getBuffer();
}
