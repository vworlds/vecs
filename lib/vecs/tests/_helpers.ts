import { DependsOn, Phase, World, type Entity } from "../src/index.js";

/**
 * Build a world with a single phase entity that has at least one (no-op)
 * system, so that calling `tick()` always flushes archetype changes.
 *
 * Returns the world, the phase, and a `tick()` shorthand.
 */
export function makeWorldWithFlushPhase(name = "p") {
  const w = new World();
  const phase = makePhase(w, name);
  // dummy system on this phase guarantees progress() has something to run.
  w.system("__flush__")
    .phase(phase)
    .run(() => {});
  return {
    w,
    phase,
    tick(now = 0, delta = 0) {
      w.progress(now, delta);
    },
    start() {
      w.start();
    },
  } as {
    w: World;
    phase: Entity;
    tick: (now?: number, delta?: number) => void;
    start: () => void;
  };
}

export function makePhase(world: World, name: string, dependsOn?: Entity): Entity {
  const phase = world.entity(name).add(Phase);
  if (dependsOn) {
    phase.set(DependsOn, { target: dependsOn });
  }
  return phase;
}
