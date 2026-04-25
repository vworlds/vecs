import { World } from "../src/index.js";
import type { IPhase } from "../src/phase.js";

/**
 * Build a world with a single phase that has at least one (no-op) system,
 * so that calling `tick()` always flushes archetype changes.
 *
 * Returns the world, the phase, and a `tick()` shorthand.
 */
export function makeWorldWithFlushPhase(name = "p") {
  const w = new World();
  const phase = w.addPhase(name);
  // dummy system on this phase guarantees runPhase(phase) calls updateArchetypes.
  w.system("__flush__").phase(phase).onRun(() => {});
  return {
    w,
    phase,
    tick(now = 0, delta = 0) {
      w.runPhase(phase, now, delta);
    },
    start() {
      w.start();
    },
  } as {
    w: World;
    phase: IPhase;
    tick: (now?: number, delta?: number) => void;
    start: () => void;
  };
}
