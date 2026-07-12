import { ClientWorld } from "@vworlds/vecs-client";
import {
  CameraBounds,
  CameraFollow,
  CameraShake,
  CameraZoom,
  phaserNetworkComponents,
  Position,
} from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { CameraModule } from "../src/index.js";
import { createMockScene } from "./mock_phaser.js";

const SESSION_EID = 1000;

describe("CameraModule", () => {
  it("centers the camera on the followed entity's Position when lerp is 1", () => {
    const { scene, session, world } = setup();
    const target = world.getOrCreateEntity(1001);
    target.set(Position, { x: 1, y: 0 });
    session.set(CameraFollow, { target, lerp: 1 });

    world.progress(0, 16);

    // coords.x(1) = 512 + 64 = 576; desired scrollX = 576 - 1024/2 = 64.
    expect(scene.cameras.main.scrollX).toBe(64);
    expect(scene.cameras.main.scrollY).toBe(0);
  });

  it("eases toward the target when lerp is below 1", () => {
    const { scene, session, world } = setup();
    const target = world.getOrCreateEntity(1001);
    target.set(Position, { x: 1, y: 0 });
    session.set(CameraFollow, { target, lerp: 0.5 });

    world.progress(0, 16);
    expect(scene.cameras.main.scrollX).toBe(32);

    world.progress(16, 16);
    expect(scene.cameras.main.scrollX).toBe(48);
  });

  it("applies zoom from the session entity and resets on removal", () => {
    const { scene, session, world } = setup();
    session.set(CameraZoom, { value: 2 });
    world.progress(0, 16);
    expect(scene.cameras.main.calls).toContainEqual({ method: "setZoom", args: [2] });

    session.remove(CameraZoom);
    world.progress(16, 16);
    expect(scene.cameras.main.calls).toContainEqual({ method: "setZoom", args: [1] });
  });

  it("ignores camera components on other entities (other players' sessions)", () => {
    const { scene, world } = setup();
    const other = world.getOrCreateEntity(2000);
    other.set(CameraZoom, { value: 3 });
    world.progress(0, 16);

    expect(scene.cameras.main.calls.some((call) => call.method === "setZoom")).toBe(false);
  });

  it("converts bounds from math-convention meters and lifts them on removal", () => {
    const { scene, session, world } = setup();
    session.set(CameraBounds, { x: -4, y: -3, width: 8, height: 6 });
    world.progress(0, 16);

    // Top-left px: x(-4) = 512-256 = 256; y(-3+6) = 384-192 = 192; size 512×384.
    expect(scene.cameras.main.calls).toContainEqual({
      method: "setBounds",
      args: [256, 192, 512, 384],
    });

    session.remove(CameraBounds);
    world.progress(16, 16);
    expect(scene.cameras.main.calls).toContainEqual({ method: "removeBounds", args: [] });
  });

  it("shakes on every CameraShake set", () => {
    const { scene, session, world } = setup();
    session.set(CameraShake, { duration: 0.5, intensity: 0.02 });
    world.progress(0, 16);
    expect(scene.cameras.main.calls).toContainEqual({ method: "shake", args: [500, 0.02] });

    session.set(CameraShake, { duration: 0.25, intensity: 0.01 });
    world.progress(16, 16);
    expect(scene.cameras.main.calls).toContainEqual({ method: "shake", args: [250, 0.01] });
  });
});

function setup(): {
  scene: ReturnType<typeof createMockScene>;
  session: ReturnType<ClientWorld["getOrCreateEntity"]>;
  world: ClientWorld;
} {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(CameraModule, { scene, pixelsPerMeter: 64, sessionEid: SESSION_EID });
  const session = world.getOrCreateEntity(SESSION_EID);
  return { scene, session, world };
}
