import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { NetworkClient, NetworkInput, ServerWorld } from "@vworlds/vecs-server";
import { describe, expect, it } from "vitest";

import { InputDecodeModule, PlayerInput } from "../src/index.js";

const ACTIONS = ["left", "right", "fire"] as const;

function createWorld(): ServerWorld {
  const world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.module(InputDecodeModule, { actions: ACTIONS });
  return world;
}

describe("InputDecodeModule", () => {
  it("decodes a well-formed payload into PlayerInput on the session entity", () => {
    const world = createWorld();
    const session = world.entity().add(NetworkClient);

    session.set(NetworkInput, { input: { a: 0b101, px: 1.5, py: -2.25, pd: true } });
    world.progress(0, 16);

    expect(session.get(PlayerInput)).toMatchObject({
      mask: 0b101,
      pointerX: 1.5,
      pointerY: -2.25,
      pointerDown: true,
    });
  });

  it("masks off unknown action bits", () => {
    const world = createWorld();
    const session = world.entity().add(NetworkClient);

    session.set(NetworkInput, { input: { a: 0xff } });
    world.progress(0, 16);

    expect(session.get(PlayerInput)!.mask).toBe(0b111);
  });

  it("zeroes malformed payloads instead of crashing", () => {
    const world = createWorld();
    const session = world.entity().add(NetworkClient);

    session.set(NetworkInput, { input: "garbage" });
    world.progress(0, 16);

    expect(session.get(PlayerInput)).toMatchObject({
      mask: 0,
      pointerX: 0,
      pointerY: 0,
      pointerDown: false,
    });
  });

  it("clamps out-of-range and non-finite pointer values", () => {
    const world = createWorld();
    const session = world.entity().add(NetworkClient);

    session.set(NetworkInput, {
      input: { a: 0, px: 1e9, py: Number.NaN, pd: "yes" },
    });
    world.progress(0, 16);

    expect(session.get(PlayerInput)).toMatchObject({
      mask: 0,
      pointerX: 1000,
      pointerY: 0,
      pointerDown: false,
    });
  });

  it("tracks later input updates reactively", () => {
    const world = createWorld();
    const session = world.entity().add(NetworkClient);

    session.set(NetworkInput, { input: { a: 0b001 } });
    world.progress(0, 16);
    session.set(NetworkInput, { input: { a: 0b010 } });
    world.progress(1, 16);

    expect(session.get(PlayerInput)!.mask).toBe(0b010);
  });
});
