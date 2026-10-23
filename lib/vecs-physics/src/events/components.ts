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

/**
 * Per-shape contact begin/end buffers. Add to opt a shape into contact events.
 * Subtree snapshots preserve the opt-in but restore fresh, empty buffers.
 * Begin/end describe contact manifold transitions, not exact geometric overlap:
 * speculative points may precede overlap, and Box2D 3.2 contact recycling may
 * delay a new begin. Published after the engine step; see `docs/events.md`.
 */
export class ContactEvents {
  begin: ContactEvent[] = [];
  end: ContactEvent[] = [];
}

/**
 * Per-shape sensor overlap begin/end buffers. Add to opt into sensor events.
 * Subtree snapshots preserve the opt-in but restore fresh, empty buffers.
 */
export class SensorEvents {
  begin: SensorEvent[] = [];
  end: SensorEvent[] = [];
}

/**
 * Per-shape hit-event buffer (fast/high-speed contacts). Add to opt into hit events.
 * Subtree snapshots preserve the opt-in but restore a fresh, empty buffer.
 */
export class HitEvents {
  hits: HitEvent[] = [];
}
