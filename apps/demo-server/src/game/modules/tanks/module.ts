import { Module, type Entity, type World } from "@vworlds/vecs";
import {
  Animation,
  CameraBounds,
  CameraFollow,
  hasAction,
  Hidden,
  Position as RenderPosition,
  Rotation as RenderRotation,
  Size,
  Sprite,
} from "@vworlds/vecs-phaser";
import { InputDecodeModule, PlayerInput } from "@vworlds/vecs-phaser-server";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  Damping,
  LinearVelocity,
  Material,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { NetworkClient, Networked, View } from "@vworlds/vecs-server";
import {
  ARENA_HALF_HEIGHT,
  ARENA_HALF_WIDTH,
  DT,
  INPUT_ACTIONS,
  TANK_FORWARD_SPEED,
  TANK_FRAMES,
  TANK_RADIUS,
  TANK_RESPAWN_SECONDS,
  TANK_REVERSE_SPEED,
  TANK_TURN_SPEED,
  TANK_VISUAL_SIZE,
} from "../../config.js";
import { GameAssets } from "../assets/module.js";
import { Respawning, Tank, TankComponents } from "./components.js";

/**
 * Player lifecycle and driving.
 *
 * - A tank spawns when a connection appears (`.with(Networked, NetworkClient)
 *   .enter`) and dies with it: the session entity owns the tank via
 *   `ChildOf`, so a disconnect cascades the destruction — no cleanup code.
 * - Driving reads the typed `PlayerInput` decoded by `InputDecodeModule`:
 *   left/right set angular velocity, up/down set velocity along the facing.
 *   Classic Combat controls, expressed as physics velocities so bounces,
 *   walls, and tank-vs-tank shoving all come from the physics engine.
 * - The track `Animation` is presence-driven: present while driving, removed
 *   when idle — the client plays/stops the tileset animation automatically.
 * - While `Respawning`, the tank is `Hidden` and its body is disabled; a
 *   countdown brings it back at its spawn corner.
 */
export class TanksModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(TankComponents);
    world.module(InputDecodeModule, { actions: [...INPUT_ACTIONS] });

    let spawnIndex = 0;

    // Every client sees the whole arena (it is small); `dsl: true` also
    // replicates session entities, which carry the camera components.
    world.component(NetworkClient).onSet((entity) => {
      entity.set(View, { dsl: true });
    });

    world
      .system("tanks.spawn")
      .with(Networked, NetworkClient)
      .enter((session) => {
        const colorIndex = spawnIndex++ % TANK_FRAMES.length;
        const tank = createTank(world, session, colorIndex);
        // Server-driven camera: follow your tank, clamped to the arena.
        session.set(CameraFollow, { lerp: 0.15, target: tank }).set(CameraBounds, {
          height: ARENA_HALF_HEIGHT * 2 + 1,
          width: ARENA_HALF_WIDTH * 2 + 1,
          x: -ARENA_HALF_WIDTH - 0.5,
          y: -ARENA_HALF_HEIGHT - 0.5,
        });
      });

    // Continuous control: velocities must track the current facing while a
    // key is held, so this is a genuine per-tick sweep (`each`), not a
    // reactive update. The tick is fixed (DT), so cooldowns count down here.
    world
      .system("tanks.drive")
      .with(Tank, PhysicsRotation)
      .without(Respawning)
      .each([Tank, PhysicsRotation], (entity, [tank, rotation]) => {
        tank.cooldown = Math.max(0, tank.cooldown - DT);
        const input = tank.session.get(PlayerInput);
        if (!input) {
          return;
        }

        const turn =
          (hasAction(input.mask, INPUT_ACTIONS, "left") ? 1 : 0) -
          (hasAction(input.mask, INPUT_ACTIONS, "right") ? 1 : 0);
        const throttle = hasAction(input.mask, INPUT_ACTIONS, "up")
          ? TANK_FORWARD_SPEED
          : hasAction(input.mask, INPUT_ACTIONS, "down")
            ? -TANK_REVERSE_SPEED
            : 0;

        entity.set(AngularVelocity, { value: turn * TANK_TURN_SPEED });
        entity.set(LinearVelocity, {
          x: Math.cos(rotation.angle) * throttle,
          y: Math.sin(rotation.angle) * throttle,
        });

        // Track animation while moving: presence-driven playback.
        const moving = turn !== 0 || throttle !== 0;
        if (moving && !entity.has(Animation)) {
          entity.set(Animation, { speed: 1, tile: TANK_FRAMES[tank.colorIndex] });
        } else if (!moving && entity.has(Animation)) {
          entity.remove(Animation);
        }
      });

    world
      .system("tanks.respawn")
      .with(Tank, Respawning)
      .each([Tank, Respawning], (entity, [tank, respawning]) => {
        respawning.seconds -= DT;
        if (respawning.seconds > 0) {
          return;
        }
        const spawn = spawnPoint(tank.colorIndex);
        entity.remove(Respawning);
        entity.remove(Hidden);
        entity
          .set(Body, { enabled: true })
          .set(PhysicsPosition, spawn)
          .set(PhysicsRotation, { angle: 0 })
          .set(LinearVelocity, { x: 0, y: 0 })
          .set(AngularVelocity, { value: 0 });
      });
  }
}

/** Knocks a tank out: hidden, body off, respawn countdown. Used by shells. */
export function destroyTank(tank: Entity): void {
  if (tank.has(Animation)) {
    tank.remove(Animation);
  }
  tank.add(Hidden).set(Body, { enabled: false }).set(Respawning, { seconds: TANK_RESPAWN_SECONDS });
}

export function spawnPoint(colorIndex: number): { x: number; y: number } {
  const margin = 1.5;
  const corners = [
    { x: -ARENA_HALF_WIDTH + margin, y: ARENA_HALF_HEIGHT - margin },
    { x: ARENA_HALF_WIDTH - margin, y: -ARENA_HALF_HEIGHT + margin },
    { x: ARENA_HALF_WIDTH - margin, y: ARENA_HALF_HEIGHT - margin },
    { x: -ARENA_HALF_WIDTH + margin, y: -ARENA_HALF_HEIGHT + margin },
  ];
  return corners[colorIndex % corners.length];
}

function createTank(world: World, session: Entity, colorIndex: number): Entity {
  const spawn = spawnPoint(colorIndex);
  const assets = world.get(GameAssets)!;
  const tank = world
    .entity()
    .childOf(session)
    .add(Networked)
    .set(Tank, { colorIndex, session })
    .set(RenderPosition, spawn)
    .set(RenderRotation, { angle: 0 })
    .set(PhysicsPosition, spawn)
    .set(PhysicsRotation, { angle: 0 })
    .set(Body, { type: BodyType.Dynamic })
    .set(Damping, { angular: 6, linear: 4 })
    .set(Sprite, { frame: TANK_FRAMES[colorIndex], texture: assets.arena.id })
    .set(Size, { height: TANK_VISUAL_SIZE, width: TANK_VISUAL_SIZE });

  // Collider child: server-local (physics shapes never cross the wire).
  // Impacts are resolved from the shell's side, so no ContactEvents here.
  world
    .entity()
    .childOf(tank)
    .set(Circle, { radius: TANK_RADIUS })
    .set(Material, { friction: 0.4, restitution: 0.2 });

  return tank;
}
