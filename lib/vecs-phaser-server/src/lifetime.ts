import { Module, ON_UPDATE } from "@vworlds/vecs";

/**
 * Server-local countdown: the entity is destroyed when `seconds` runs out.
 * Not networked — clients see the entity disappear through normal removal
 * replication.
 *
 * The idiomatic driver for one-shot effect entities: spawn an entity with a
 * `Sound`/`ParticleBurst`-style component plus a short `Lifetime`, and the
 * cleanup is automatic.
 */
export class Lifetime {
  /** Remaining time to live, in seconds. */
  public seconds = 1;
}

/**
 * Installs the `Lifetime` countdown. Runs in `ON_UPDATE`; `world.progress`
 * deltas are milliseconds (the convention across the vecs suite).
 */
export class LifetimeModule extends Module {
  public init(): void {
    const world = this.world;

    world.component(Lifetime);
    const expiring = world.query("phaser.lifetime").with(Lifetime).track();

    world
      .system("phaser.lifetime.expire")
      .phase(ON_UPDATE)
      .run((_now, delta) => {
        expiring.forEach([Lifetime], (entity, [lifetime]) => {
          // Server-local bookkeeping: mutate in place without modified() —
          // nothing observes the countdown, only the expiry.
          lifetime.seconds -= delta / 1000;
          if (lifetime.seconds <= 0) {
            entity.destroy();
          }
        });
      });
  }
}
