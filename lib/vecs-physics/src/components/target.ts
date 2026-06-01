// Kinematic target components. Drive a kinematic body toward a target pose; once
// within `tolerance` physics leaves the component in place and stops driving.
// Public API — see `docs/components.md`.

/** Target world-space position for a kinematic body. */
export class KinematicTargetPosition {
  x = 0;
  y = 0;
  tolerance = 0.001;
  wake = true;
}

/** Target world-space rotation (radians) for a kinematic body. */
export class KinematicTargetRotation {
  angle = 0;
  tolerance = 0.001;
  wake = true;
}
