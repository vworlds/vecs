// `PhysicsEventOptInSync` — keep a shape's engine-side event opt-in flags in
// sync when `ContactEvents` / `HitEvents` / `SensorEvents` are added to or
// removed from an already-created shape entity at runtime.
//
// Phase: registered via `onAdd` / `onRemove` hooks (synchronous, fire while the
// command queue drains). A no-op system is created only so the entity can be
// tagged with `PhysicsSystemTag` and the install order stays uniform with the
// other physics systems.
//
// WHY THIS EXISTS
//
// `PhysicsShapeLifecycle.enter` reads `e.get(ContactEvents/HitEvents/SensorEvents)`
// ONCE, at shape creation, to seed `InternalShape.enableContactEvents` /
// `enableHitEvents` / `enableSensorEvents`. Nothing else updated those flags, so
// `shape.add(ContactEvents)` (or `.remove(...)`) AFTER the shape entered the
// engine was a silent no-op — the documented "add an event component when you
// want events" contract (docs/events.md) only worked at creation time. box2d
// exposes `b2Shape_EnableContactEvents` / `b2Shape_EnableHitEvents` /
// `b2Shape_EnableSensorEvents` precisely so these can be toggled at runtime;
// this system restores that capability.
//
// Per-flag propagation:
//   - ContactEvents → `enableContactEvents`. The contact-events flag lives on
//     the persistent `InternalContact` and is only set at createContact time,
//     so existing contacts are refreshed via `refreshShapeContactEventFlag`.
//   - HitEvents → `enableHitEvents`. No contact walk needed: `updateContact`
//     recomputes `SIM_ENABLE_HIT_EVENT` from the shapes every step, so the next
//     step picks the change up.
//   - SensorEvents → `enableSensorEvents`. No contact walk: the sensor overlap
//     pass reads `enableSensorEvents` every step (both the sensor's own
//     early-exit and the visitor-detection rule), so the next overlap pass
//     diffs begin/end correctly.
//
// NOTE — the `Sensor` MARKER (solid ↔ sensor conversion) is deliberately NOT
// handled at runtime in v1: it needs contact teardown + SensorStorage
// create/destroy + mass/proxy invariants and is a documented deferral
// (see PhysicsMaterialFilterSync and PROGRESS.md → Carried into M5). Shape
// recreation (remove + re-add geometry) is the supported way to change sensor
// status before then. This system only syncs the event-opt-in components.
//
// Hooks fire during command drain, BEFORE the lifecycle systems run. At shape
// CREATION the `add(ContactEvents)` command drains before
// `PhysicsShapeLifecycle.enter` has built the `InternalShape`, so the shape
// lookup misses and the hook no-ops — which is correct, because creation-time
// opt-in is already handled by `enter`. The hooks only do work for components
// toggled on a shape that already exists in the engine.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { refreshShapeContactEventFlag } from "../engine/contact.js";
import type { InternalShape } from "../engine/shape.js";
import { type PhysicsState } from "../engine/state.js";

/** Which engine-side flag a given event component maps to. */
type EventFlag = "contact" | "hit" | "sensor";

/** Create `PhysicsEventOptInSync` on `world`, bound to `state` and `phase`.
 * Registers add/remove hooks for the three event components and returns a no-op
 * system so the caller can tag its entity. */
export function installEventOptInSync(world: World, state: PhysicsState, phase: IPhase): System {
  world.component(ContactEvents).onAdd((e) => applyToShapes(state, e.eid, "contact", true));
  world.component(ContactEvents).onRemove((e) => applyToShapes(state, e.eid, "contact", false));

  world.component(HitEvents).onAdd((e) => applyToShapes(state, e.eid, "hit", true));
  world.component(HitEvents).onRemove((e) => applyToShapes(state, e.eid, "hit", false));

  world.component(SensorEvents).onAdd((e) => applyToShapes(state, e.eid, "sensor", true));
  world.component(SensorEvents).onRemove((e) => applyToShapes(state, e.eid, "sensor", false));

  return world
    .system("PhysicsEventOptInSync")
    .phase(phase)
    .run(() => {
      // No per-frame work: the onAdd/onRemove hooks do everything synchronously.
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Set `flag` to `value` on the InternalShape(s) for `eid` (single shape or all
 * chain segments) and refresh existing contacts when the contact-events flag
 * changed. No-op when no engine shape exists yet (creation-time opt-in is
 * handled by `PhysicsShapeLifecycle.enter`). */
function applyToShapes(state: PhysicsState, eid: number, flag: EventFlag, value: boolean): void {
  const chainHandles = state.chainShapeByEntity.get(eid);
  if (chainHandles !== undefined) {
    for (const h of chainHandles) {
      const seg = state.shapes.records[h.index];
      if (seg !== undefined) {
        applyFlag(state, seg, h.index, flag, value);
      }
    }
    return;
  }

  const handle = state.shapeByEntity.get(eid);
  if (handle === undefined) {
    return;
  }
  const shape = state.shapes.records[handle.index];
  if (shape === undefined) {
    return;
  }
  applyFlag(state, shape, handle.index, flag, value);
}

/** Write `flag` onto `shape` and, for contact events, refresh the shape's
 * existing contacts. Hit/sensor flags are re-read each step by the engine, so
 * no contact walk is needed for them. */
function applyFlag(
  state: PhysicsState,
  shape: InternalShape,
  shapeIndex: number,
  flag: EventFlag,
  value: boolean
): void {
  switch (flag) {
    case "contact":
      shape.enableContactEvents = value;
      refreshShapeContactEventFlag(state, shape.bodyHandle.index, shapeIndex);
      break;
    case "hit":
      shape.enableHitEvents = value;
      break;
    case "sensor":
      shape.enableSensorEvents = value;
      break;
  }
}
