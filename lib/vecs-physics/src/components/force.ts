// Force, torque, and one-shot impulse components. May live on a body entity or
// an immediate child of one. `wake` controls whether applying the load wakes a
// sleeping body. Impulses are zeroed silently after they are applied (see PLAN →
// PhysicsImpulseZero). Public API — see `docs/components.md`.

/** Persistent force in newtons. */
export class Force {
  x = 0;
  y = 0;
  wake = true;
}

/** Persistent torque (angular force). */
export class Torque {
  value = 0;
  wake = true;
}

/** One-shot linear impulse in newton-seconds. Zeroed silently after applied. */
export class Impulse {
  x = 0;
  y = 0;
  wake = true;
}

/** One-shot angular impulse. Zeroed silently after applied. */
export class AngularImpulse {
  value = 0;
  wake = true;
}
