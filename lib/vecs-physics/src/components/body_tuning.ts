// Optional body tunables. `Body` stays small; less common settings live here so
// they only cost an archetype slot when actually used. Defaults match
// `b2DefaultBodyDef()`. Public API — see `docs/components.md`.

/** Linear and angular velocity damping. */
export class Damping {
  linear = 0;
  angular = 0;
}

/** Per-body multiplier on world gravity. */
export class GravityScale {
  value = 1;
}

/** Restricts body translation (x/y) or rotation. */
export class MotionLocks {
  x = false;
  y = false;
  rotation = false;
}

/** Per-body sleep behaviour. `threshold` is in metres/second (b2 sleepThreshold). */
export class Sleep {
  enabled = true;
  awake = true;
  threshold = 0.05;
}
