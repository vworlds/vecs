// Force, torque, and one-shot impulse components. May live on a body entity or
// an immediate child of one. `wake` controls whether applying a non-zero load
// wakes a sleeping body; a zero load is never applied and never wakes one.
// Impulses are zeroed silently after they are applied (see PLAN →
// PhysicsImpulseZero). Public API — see `docs/components.md`.

/** Persistent force in newtons. */
export class Force {
  x = 0;
  y = 0;
  /**
   * Whether a non-zero force wakes a sleeping body. Defaults to `true`.
   *
   * With `wake: false` a sleeping body stays asleep and ignores the force. A zero force
   * (`x === 0 && y === 0`) is never applied and never wakes a body, whatever `wake` says, so a
   * body holding an idle `Force { x: 0, y: 0 }` can still fall asleep. To wake a body, or keep it
   * awake, use the `Sleep` component: `awake: true` wakes it and `enabled: false` stops it from
   * falling asleep.
   */
  wake = true;
}

/** Persistent torque (angular force). */
export class Torque {
  value = 0;
  /**
   * Whether a non-zero torque wakes a sleeping body. Defaults to `true`.
   *
   * With `wake: false` a sleeping body stays asleep and ignores the torque. A zero torque
   * (`value === 0`) is never applied and never wakes a body, whatever `wake` says, so a body
   * holding an idle `Torque { value: 0 }` can still fall asleep. To wake a body, or keep it
   * awake, use the `Sleep` component: `awake: true` wakes it and `enabled: false` stops it from
   * falling asleep.
   */
  wake = true;
}

/** One-shot linear impulse in newton-seconds. Zeroed silently after applied. */
export class Impulse {
  x = 0;
  y = 0;
  /**
   * Whether a non-zero impulse wakes a sleeping body. Defaults to `true`.
   *
   * Non-zero impulses set on a body before a step are summed, and the sum wakes the body if any
   * of them has `wake: true`. With `wake: false` throughout, a sleeping body stays asleep and
   * ignores the impulse. A zero impulse is ignored when it is set: it is not summed and its
   * `wake` does not count. A sum that is exactly zero, such as `{ x: 5 }` followed by
   * `{ x: -5 }`, is skipped when the impulses are applied. Neither wakes a body. To wake a body,
   * or keep it awake, use the `Sleep` component: `awake: true` wakes it and `enabled: false`
   * stops it from falling asleep.
   */
  wake = true;
}

/** One-shot angular impulse. Zeroed silently after applied. */
export class AngularImpulse {
  value = 0;
  /**
   * Whether a non-zero angular impulse wakes a sleeping body. Defaults to `true`.
   *
   * Non-zero angular impulses set on a body before a step are summed, and the sum wakes the body
   * if any of them has `wake: true`. With `wake: false` throughout, a sleeping body stays asleep
   * and ignores the impulse. A zero impulse is ignored when it is set: it is not summed and its
   * `wake` does not count. A sum that is exactly zero, such as `3` followed by `-3`, is skipped
   * when the impulses are applied. Neither wakes a body. To wake a body, or keep it awake, use
   * the `Sleep` component: `awake: true` wakes it and `enabled: false` stops it from falling
   * asleep.
   */
  wake = true;
}
