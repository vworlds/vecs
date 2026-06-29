// Opt-in event buffers attached to shape entities. Arrays are cleared and reused
// each physics step; physics marks the component modified only when new events
// arrive (see PLAN → PhysicsEvents). The field initialisers give each instance
// its own arrays. Public API — see `docs/components.md`.

import type { Entity } from "@vworlds/vecs";

/** A single contact begin/end event. `other` is the colliding shape entity. */
export type ContactEvent = {
  other: Entity;
};

/** A single sensor overlap begin/end event. */
export type SensorEvent = {
  other: Entity;
};

/** A single hit event: contact point, normal, and approach speed. */
export type HitEvent = {
  other: Entity;
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  speed: number;
};

/** Per-shape contact begin/end buffers. Add to opt a shape into contact events. */
export class ContactEvents {
  begin: ContactEvent[] = [];
  end: ContactEvent[] = [];
}

/** Per-shape sensor overlap begin/end buffers. */
export class SensorEvents {
  begin: SensorEvent[] = [];
  end: SensorEvent[] = [];
}

/** Per-shape hit-event buffer (fast/high-speed contacts). */
export class HitEvents {
  hits: HitEvent[] = [];
}
