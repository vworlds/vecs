import express from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { type Entity } from "@vworlds/vecs";
import {
  Animation,
  CameraBounds,
  CameraFollow,
  CameraShake,
  Hidden,
  ParticleBurst,
  ScreenAnchor,
  Sound,
  Sprite,
  Text,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import { AssetManager, PhaserServerModule } from "@vworlds/vecs-phaser-server";
import { PhysicsModule, Position as PhysicsPosition, preloadPhysics } from "@vworlds/vecs-physics";
import { NetworkClient, NetworkInput, Networked, ServerWorld } from "@vworlds/vecs-server";
import { DT, DT_MS, INPUT_ACTIONS } from "../src/game/config.js";
import { TankArenaModule } from "../src/game/module.js";
import { Respawning, Tank } from "../src/game/modules/tanks/components.js";
import { Shell } from "../src/game/modules/shells/components.js";

const FIRE_BIT = 1 << INPUT_ACTIONS.indexOf("fire");

beforeAll(async () => {
  await preloadPhysics();
});

function createGame(): ServerWorld {
  const world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.module(PhysicsModule, { fixedTimeStep: DT, gravity: { x: 0, y: 0 }, subSteps: 4 });
  world.module(PhaserServerModule);
  world.module(TankArenaModule, {
    app: express(),
    assets: new AssetManager({ assetsPath: "assets" }),
    worldName: "test",
  });
  return world;
}

/** Simulates a connection: the session entity a real socket would create. */
function connect(world: ServerWorld): Entity {
  return world.entity().add(Networked).add(NetworkClient);
}

function tick(world: ServerWorld, times = 1): void {
  for (let i = 0; i < times; i++) {
    world.progress((i + 1) * DT_MS, DT * 1000);
  }
}

function findAll(world: ServerWorld, Component: new () => object): Entity[] {
  const results: Entity[] = [];
  for (const [, entity] of world.entities) {
    if (entity.alive && entity.has(Component)) {
      results.push(entity);
    }
  }
  return results;
}

describe("Tank Arena", () => {
  it("spawns a tank with camera follow and a scoreboard row for each connection", () => {
    const world = createGame();
    const session = connect(world);
    tick(world);

    const tanks = findAll(world, Tank);
    expect(tanks).toHaveLength(1);
    const tank = tanks[0];
    expect(tank.has(Sprite)).toBe(true);
    expect(tank.get(PhysicsPosition)).toBeDefined();

    // The session entity carries the camera components, aimed at the tank.
    expect(session.target(CameraFollow)).toBe(tank);
    expect(session.has(CameraBounds)).toBe(true);

    // HUD: a screen-anchored scoreboard row plus the title text.
    const anchored = findAll(world, ScreenAnchor);
    expect(anchored.some((entity) => entity.get(Text)?.value.includes("GREEN"))).toBe(true);
  });

  it("fires a shell (with muzzle sound) on the fire action, gated by cooldown", () => {
    const world = createGame();
    const session = connect(world);
    tick(world);

    session.set(NetworkInput, { input: { a: FIRE_BIT } });
    tick(world, 2);

    expect(findAll(world, Shell)).toHaveLength(1);
    expect(findAll(world, Sound).length).toBeGreaterThan(0);

    // Held fire key: still one shell until the cooldown elapses.
    tick(world, 2);
    expect(findAll(world, Shell)).toHaveLength(1);
  });

  it("drives the track animation from movement input, presence-driven", () => {
    const world = createGame();
    const session = connect(world);
    tick(world);
    const tank = findAll(world, Tank)[0];

    expect(tank.has(Animation)).toBe(false);
    session.set(NetworkInput, { input: { a: 1 << INPUT_ACTIONS.indexOf("up") } });
    tick(world, 2);
    expect(tank.has(Animation)).toBe(true);

    session.set(NetworkInput, { input: { a: 0 } });
    tick(world, 2);
    expect(tank.has(Animation)).toBe(false);
  });

  it("a shell hit knocks the victim out, credits the shooter, and spawns an explosion", () => {
    const world = createGame();
    const shooterSession = connect(world);
    const victimSession = connect(world);
    tick(world);

    const tanks = findAll(world, Tank);
    const shooter = tanks.find((t) => t.get(Tank)!.session === shooterSession)!;
    const victim = tanks.find((t) => t.get(Tank)!.session === victimSession)!;

    // Stage a point-blank duel: shooter at origin facing +x, victim 2 m away.
    shooter.set(PhysicsPosition, { x: 0, y: 0 });
    victim.set(PhysicsPosition, { x: 2, y: 0 });
    tick(world);

    shooterSession.set(NetworkInput, { input: { a: FIRE_BIT } });
    tick(world, 20);

    expect(victim.has(Respawning)).toBe(true);
    expect(victim.has(Hidden)).toBe(true);
    expect(shooter.get(Tank)!.score).toBe(1);
    expect(findAll(world, ParticleBurst).length).toBeGreaterThan(0);
    // The victim's camera got shaken (component set on their session).
    expect(victimSession.has(CameraShake)).toBe(true);
  });

  it("respawns a destroyed tank after the countdown", () => {
    const world = createGame();
    const shooterSession = connect(world);
    const victimSession = connect(world);
    tick(world);
    const tanks = findAll(world, Tank);
    const shooter = tanks.find((t) => t.get(Tank)!.session === shooterSession)!;
    const victim = tanks.find((t) => t.get(Tank)!.session === victimSession)!;
    shooter.set(PhysicsPosition, { x: 0, y: 0 });
    victim.set(PhysicsPosition, { x: 2, y: 0 });
    tick(world);
    shooterSession.set(NetworkInput, { input: { a: FIRE_BIT } });
    tick(world, 20);
    expect(victim.has(Respawning)).toBe(true);

    // Cease fire and run past the respawn countdown.
    shooterSession.set(NetworkInput, { input: { a: 0 } });
    tick(world, Math.ceil(3 / DT));
    expect(victim.has(Respawning)).toBe(false);
    expect(victim.has(Hidden)).toBe(false);
  });
});
