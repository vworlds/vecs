import { Module, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { ParticleBurst, Position } from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";

export interface EffectsModuleConfig {
  readonly scene: Phaser.Scene;
  /** Pixels per meter; must match the render module. Default 64. */
  readonly pixelsPerMeter?: number;
}

/**
 * Expands `ParticleBurst` components into Phaser particle emitters: every
 * set (including entry) explodes one burst at the entity's `Position`; the
 * emitter is disposed after the particles die. The entity needs no other
 * renderable — a typical burst is a short-lived `ParticleBurst` + `Position`
 * entity expired by the server's `Lifetime`.
 */
export class EffectsModule extends Module<EffectsModuleConfig> {
  public init(config: EffectsModuleConfig): void {
    const { scene } = config;
    const coords = new CoordSpace(scene, config.pixelsPerMeter);
    const world = this.world;

    world
      .system("phaser.effects.burst")
      .with(ParticleBurst, Position)
      .phase(ON_STORE)
      .update({ watch: ParticleBurst, onEnter: true, inject: [Position] }, (_e, burst, [pos]) => {
        const maxSpeed = coords.len(burst.speed);
        const emitter = scene.add.particles(
          coords.x(pos.x),
          coords.y(pos.y),
          String(burst.texture),
          {
            emitting: false,
            frame: burst.frame,
            gravityY: -coords.len(burst.gravityY),
            lifespan: burst.lifespanMs,
            scale: { start: burst.scale, end: 0 },
            speed: { min: maxSpeed / 2, max: maxSpeed },
            tint: burst.tint,
          }
        );
        emitter.explode(burst.count);
        scene.time.delayedCall(burst.lifespanMs, () => emitter.destroy());
      });
  }
}
