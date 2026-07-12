import { Module, ON_VALIDATE, type Entity, type World } from "@vworlds/vecs";
import {
  Animation,
  CameraShake,
  hasAction,
  Image,
  ParticleBurst,
  Position as RenderPosition,
  Size,
  Sound,
  Sprite,
} from "@vworlds/vecs-phaser";
import { Lifetime, LifetimeModule, PlayerInput } from "@vworlds/vecs-phaser-server";
import {
  Body,
  BodyType,
  Circle,
  ContactEvents,
  GravityScale,
  LinearVelocity,
  Material,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import {
  FRAME_EXPLOSION,
  FRAME_SHELL,
  FRAME_SPARK,
  INPUT_ACTIONS,
  SHELL_COOLDOWN_SECONDS,
  SHELL_LIFETIME_SECONDS,
  SHELL_MUZZLE_OFFSET,
  SHELL_RADIUS,
  SHELL_SPEED,
  SHELL_VISUAL_SIZE,
  TANK_TINTS,
} from "../../config.js";
import { GameAssets } from "../assets/module.js";
import { Respawning, Tank } from "../tanks/components.js";
import { destroyTank } from "../tanks/module.js";
import { Shell, ShellComponents } from "./components.js";

/**
 * Firing and shell impact.
 *
 * - Firing is a per-tick check on the fire action gated by the tank's
 *   cooldown (a held key keeps firing at the cooldown rate — arcade rules).
 * - A shell is a tiny bouncy physics body (`bullet: true` for CCD, gravity
 *   off, restitution 1) with a server `Lifetime`; the walls' restitution
 *   makes it ricochet, Combat-style.
 * - Impact handling is reactive: the shell collider opts into
 *   `ContactEvents`, and one `.update(ContactEvents)` system in ON_VALIDATE
 *   resolves what was hit. Hitting a live tank (not the shooter) knocks it
 *   out, credits the shooter, spawns a one-shot explosion entity
 *   (ParticleBurst + Sound + Lifetime — the client-expansion pattern), and
 *   shakes the victim's camera. Any other contact is a ricochet ping.
 */
export class ShellsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(ShellComponents);
    world.module(LifetimeModule);

    world
      .system("shells.fire")
      .with(Tank, PhysicsPosition, PhysicsRotation)
      .without(Respawning)
      .each([Tank, PhysicsPosition, PhysicsRotation], (tankEntity, [tank, position, rotation]) => {
        const input = tank.session.get(PlayerInput);
        if (!input || !hasAction(input.mask, INPUT_ACTIONS, "fire") || tank.cooldown > 0) {
          return;
        }
        tank.cooldown = SHELL_COOLDOWN_SECONDS;
        fireShell(world, tankEntity, position, rotation.angle);
      });

    // Shell impact: reactive, in ON_VALIDATE (after the physics phases have
    // published this tick's contacts).
    world
      .system("shells.impact")
      .phase(ON_VALIDATE)
      .update(ContactEvents, (colliderEntity, events) => {
        const shellEntity = colliderEntity.parent;
        const shell = shellEntity?.get(Shell);
        if (!shellEntity || !shell) {
          return; // a tank collider's contacts; shells drive the outcome
        }
        for (const contact of events.begin) {
          const otherBody = contact.other.parent;
          const tank = otherBody?.get(Tank);
          if (otherBody && tank && otherBody !== shell.shooter && !otherBody.has(Respawning)) {
            explodeTank(world, otherBody, tank, shell.shooter);
            shellEntity.destroy();
            return;
          }
          ricochet(world, shellEntity);
        }
      });
  }
}

function fireShell(
  world: World,
  shooter: Entity,
  position: Readonly<PhysicsPosition>,
  angle: number
): void {
  const assets = world.get(GameAssets)!;
  const spawn = {
    x: position.x + Math.cos(angle) * SHELL_MUZZLE_OFFSET,
    y: position.y + Math.sin(angle) * SHELL_MUZZLE_OFFSET,
  };
  const shell = world
    .entity()
    .add(Networked)
    .set(Shell, { shooter })
    .set(RenderPosition, spawn)
    .set(PhysicsPosition, spawn)
    .set(PhysicsRotation, { angle })
    .set(Body, { bullet: true, type: BodyType.Dynamic })
    .set(GravityScale, { value: 0 })
    .set(LinearVelocity, { x: Math.cos(angle) * SHELL_SPEED, y: Math.sin(angle) * SHELL_SPEED })
    .set(Image, { frame: FRAME_SHELL, texture: assets.arena.id })
    .set(Size, { height: SHELL_VISUAL_SIZE, width: SHELL_VISUAL_SIZE })
    .set(Lifetime, { seconds: SHELL_LIFETIME_SECONDS });

  world
    .entity()
    .childOf(shell)
    .set(Circle, { radius: SHELL_RADIUS })
    .set(Material, { density: 0.3, friction: 0, restitution: 1 })
    .add(ContactEvents);

  // Muzzle report: a one-shot effect entity that cleans itself up.
  world
    .entity()
    .add(Networked)
    .set(Sound, { asset: assets.fireSound.id, volume: 0.5 })
    .set(Lifetime, { seconds: 0.5 });
}

function explodeTank(world: World, tankEntity: Entity, tank: Tank, shooter: Entity): void {
  const assets = world.get(GameAssets)!;
  const position = tankEntity.get(PhysicsPosition) ?? { x: 0, y: 0 };

  // One-shot explosion: spark burst + fireball animation + boom, all on
  // short-lived entities expired by Lifetime on the server. The client
  // expands the burst into a local particle emitter (client-expansion
  // pattern) and plays the tileset animation — no per-particle replication.
  world
    .entity()
    .add(Networked)
    .set(RenderPosition, { x: position.x, y: position.y })
    .set(ParticleBurst, {
      count: 26,
      frame: FRAME_SPARK,
      gravityY: 0,
      lifespanMs: 550,
      scale: 0.9,
      speed: 3.5,
      texture: assets.arena.id,
      tint: TANK_TINTS[tank.colorIndex],
    })
    .set(Sound, { asset: assets.explosionSound.id, volume: 0.9 })
    .set(Lifetime, { seconds: 1 });

  world
    .entity()
    .add(Networked)
    .set(RenderPosition, { x: position.x, y: position.y })
    .set(Sprite, { frame: FRAME_EXPLOSION, texture: assets.arena.id })
    .set(Animation, { tile: FRAME_EXPLOSION })
    .set(Size, { height: 1.1, width: 1.1 })
    .set(Lifetime, { seconds: 0.28 });

  // Rattle the victim's screen — their session entity carries the camera.
  tank.session.set(CameraShake, { duration: 0.4, intensity: 0.02 });

  if (shooter.alive && shooter.has(Tank)) {
    shooter.getMut(Tank, (mutable) => {
      mutable.score += 1;
    });
  }

  destroyTank(tankEntity);
}

function ricochet(world: World, shellEntity: Entity): void {
  const assets = world.get(GameAssets)!;
  const position = shellEntity.get(PhysicsPosition);
  if (!position) {
    return;
  }
  world
    .entity()
    .add(Networked)
    .set(Sound, { asset: assets.bounceSound.id, volume: 0.25 })
    .set(Lifetime, { seconds: 0.3 });
}
