// Shape-local pose components, relative to the immediate parent body. Optional:
// missing means the identity offset. Public API — see `docs/components.md`.

/** Local shape offset from the parent body origin. */
export class ShapePosition {
  x = 0;
  y = 0;
}

/** Local shape rotation in radians. */
export class ShapeRotation {
  angle = 0;
}
