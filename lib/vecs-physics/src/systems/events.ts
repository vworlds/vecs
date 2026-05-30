// `PhysicsEvents` — fans raw engine event arrays out to ECS event components.
//
// Phase: `physics-post`, BETWEEN `PhysicsPoseSyncOut` and `PhysicsImpulseZero`.
//
// Reads three raw event arrays from `PhysicsState`:
//   - `contactBeginEvents` / `contactEndEvents`   (ContactTouchEvent, VP-21a)
//   - `sensorBeginEvents`  / `sensorEndEvents`    (SensorTouchEvent,  VP-21c)
//   - `contactHitEvents`                          (ContactHitEvent,   VP-22)
//
// For each kind it resolves shape handles → entity IDs, validates them via
// `IdPool.isValid`, and writes payloads into the `ContactEvents`, `SensorEvents`,
// and `HitEvents` components using the PLAN.md clear-in-place / previously-touched
// pattern (see PLAN.md → _PhysicsEvents_):
//
//   1. Build `touched = new Set<eid>()` for this kind.
//   2. For each receiving entity: if not yet in `touched`, clear the component
//      arrays in place (preserves the user's array reference) and add to `touched`.
//   3. Push the event payload.
//   4. After all events pushed: call `entity.modified(Component)` for each eid in
//      `touched` — modified fires ONLY when new events arrived this step.
//   5. For each eid in `previouslyTouched` but NOT in `touched`: silently clear
//      (no `modified`) so last step's events vanish without waking watchers.
//   6. Set `previouslyTouched = touched` for next step.
//
// Three independent `previouslyTouched` Sets are kept as closure-local state —
// they do NOT live on `PhysicsState` (they are publish-layer state only).
//
// DELIVERY SEMANTICS (see docs/events.md):
//   - Contact events: BOTH shapes receive an event with `other` = the other shape.
//     Either shape that is missing the `ContactEvents` component is silently skipped.
//   - Sensor events: ONLY the SENSOR shape's `SensorEvents` component receives an
//     event with `other` = the visitor entity. The visitor does NOT receive one.
//   - Hit events: BOTH shapes receive `HitEvents` with `other` = the other shape.
//     The stored A→B normal is used for BOTH sides (not flipped per side — box2d
//     does not specify per-side normal flipping in `b2ContactHitEvent`).
//
// EVENT-CLEARING RELOCATION (ARCHITECT RESOLUTION, PROGRESS.md VP-21a):
//   VP-21a/c/22 cleared their raw arrays at the TOP of `engineStep`. That order
//   means physics-pre teardown end-events and between-frame `entity.destroy()`
//   end-events were cleared before VP-21b could publish them. The fix: clear all
//   five ECS-bound raw arrays HERE, at the END of `PhysicsEvents.run`, AFTER
//   publishing. `bodyMoveEvents` stays in `engineStep` (step-only; consumed by
//   `PhysicsPoseSyncOut` in the same post phase, before us).
//
// InternalShape.entity vs InternalBody.entity (VP-11 review, carried into M4):
//   `InternalShape.entity` is a plain `number` (eid), while `InternalBody.entity`
//   is a Vecs `Entity`. This system resolves eid → Entity via `world.getEntity(eid)`.
//   No structural change to InternalShape is needed; `world.getEntity` is the correct
//   bridge. The "carried-into-M4: reconcile" item is RESOLVED HERE — no separate
//   reconcile pass is required.

import { type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { type ContactHitEvent, type PhysicsState } from "../engine/state.js";
import type { Handle } from "../util/handle.js";

/** Create `PhysicsEvents` on `world`, bound to `state` and `phase`. Returns
 * the system so the caller can tag its entity. */
export function installEvents(world: World, state: PhysicsState, phase: IPhase): System {
  // Three independent "previously touched" sets, one per event kind.
  // Closure-local: publish-layer state that does not belong on PhysicsState.
  let prevTouchedContact = new Set<number /* eid */>();
  let prevTouchedSensor = new Set<number /* eid */>();
  let prevTouchedHit = new Set<number /* eid */>();

  return world
    .system("PhysicsEvents")
    .phase(phase)
    .run(() => {
      // ── 1. Contact events ──────────────────────────────────────────────────
      //
      // Delivery: BOTH sides receive. For {shapeA, shapeB}:
      //   shapeA receives ContactEvents with other = entityB
      //   shapeB receives ContactEvents with other = entityA
      const touchedContact = new Set<number /* eid */>();

      for (const ev of state.contactBeginEvents) {
        _emitContact(state, touchedContact, ev.shapeA, ev.entityEidA, ev.entityEidB, "begin");
        _emitContact(state, touchedContact, ev.shapeB, ev.entityEidB, ev.entityEidA, "begin");
      }
      for (const ev of state.contactEndEvents) {
        _emitContact(state, touchedContact, ev.shapeA, ev.entityEidA, ev.entityEidB, "end");
        _emitContact(state, touchedContact, ev.shapeB, ev.entityEidB, ev.entityEidA, "end");
      }

      // Notify modified for shapes that received events this step.
      for (const eid of touchedContact) {
        world.getEntity(eid)?.modified(ContactEvents);
      }

      // Silently clear last step's events for shapes that got nothing this step.
      for (const eid of prevTouchedContact) {
        if (touchedContact.has(eid)) {
          continue;
        }
        const e = world.getEntity(eid);
        if (e === undefined) {
          continue;
        }
        const ev = e.get(ContactEvents) as ContactEvents | undefined;
        if (ev === undefined) {
          continue;
        }
        ev.begin.length = 0;
        ev.end.length = 0;
        // No entity.modified — silent clear does not wake watchers.
      }
      prevTouchedContact = touchedContact;

      // ── 2. Sensor events ───────────────────────────────────────────────────
      //
      // Delivery: ONLY the sensor shape's SensorEvents component receives an event
      // with other = visitorEntity. The visitor does NOT receive one.
      const touchedSensor = new Set<number /* eid */>();

      for (const ev of state.sensorBeginEvents) {
        _emitSensor(
          state,
          touchedSensor,
          ev.sensorShape,
          ev.sensorEntityEid,
          ev.visitorEntityEid,
          "begin"
        );
      }
      for (const ev of state.sensorEndEvents) {
        _emitSensor(
          state,
          touchedSensor,
          ev.sensorShape,
          ev.sensorEntityEid,
          ev.visitorEntityEid,
          "end"
        );
      }

      for (const eid of touchedSensor) {
        world.getEntity(eid)?.modified(SensorEvents);
      }

      for (const eid of prevTouchedSensor) {
        if (touchedSensor.has(eid)) {
          continue;
        }
        const e = world.getEntity(eid);
        if (e === undefined) {
          continue;
        }
        const sev = e.get(SensorEvents) as SensorEvents | undefined;
        if (sev === undefined) {
          continue;
        }
        sev.begin.length = 0;
        sev.end.length = 0;
      }
      prevTouchedSensor = touchedSensor;

      // ── 3. Hit events ──────────────────────────────────────────────────────
      //
      // Delivery: BOTH sides receive. Normal stays the stored A→B value for both
      // sides — box2d's b2ContactHitEvent does not specify per-side normal flipping.
      const touchedHit = new Set<number /* eid */>();

      for (const ev of state.contactHitEvents) {
        _emitHit(state, touchedHit, ev.shapeA, ev.entityEidA, ev.entityEidB, ev);
        _emitHit(state, touchedHit, ev.shapeB, ev.entityEidB, ev.entityEidA, ev);
      }

      for (const eid of touchedHit) {
        world.getEntity(eid)?.modified(HitEvents);
      }

      for (const eid of prevTouchedHit) {
        if (touchedHit.has(eid)) {
          continue;
        }
        const e = world.getEntity(eid);
        if (e === undefined) {
          continue;
        }
        const hev = e.get(HitEvents) as HitEvents | undefined;
        if (hev === undefined) {
          continue;
        }
        hev.hits.length = 0;
      }
      prevTouchedHit = touchedHit;

      // ── EVENT-CLEARING RELOCATION (ARCHITECT RESOLUTION) ──────────────────
      //
      // Clear all five ECS-bound raw event arrays HERE, after publishing.
      // Events generated in physics-pre (lifecycle teardown, entity.destroy())
      // and between-frame user destroys now survive to the publish.
      // This replaces the per-array clears that lived at the TOP of engineStep.
      //
      // bodyMoveEvents is NOT cleared here — it is step-only, consumed by
      // PhysicsPoseSyncOut (earlier in this phase), and cleared in engineStep.
      state.contactBeginEvents.length = 0;
      state.contactEndEvents.length = 0;
      state.sensorBeginEvents.length = 0;
      state.sensorEndEvents.length = 0;
      state.contactHitEvents.length = 0;

      // ── Lazy cleanup of shapeEntityByEid (VP-21b) ─────────────────────────
      //
      // `shapeEntityByEid` is populated in PhysicsShapeLifecycle.enter and NOT
      // deleted in exit (so that destroyed entities' Entity objects survive to
      // this publish point — Entity objects persist as JS objects after destroy).
      // We clean up stale entries HERE (in physics-post after publishing) so the
      // map doesn't grow without bound. An entry is stale when the eid is no
      // longer in shapeByEntity or chainShapeByEntity (shape was destroyed).
      for (const eid of state.shapeEntityByEid.keys()) {
        if (!state.shapeByEntity.has(eid) && !state.chainShapeByEntity.has(eid)) {
          state.shapeEntityByEid.delete(eid);
        }
      }
    });
}

// ─── Module-level helpers (Stepdown Rule: high-level above, helpers below) ────

/** Emit one side of a contact begin/end event.
 * `selfHandle` guards against stale slot reuse; `selfEid`/`otherEid` are the
 * entity eids captured at emit time. Uses `state.shapeEntityByEid` so that end
 * events generated by teardown in physics-pre (where the shape record may be
 * freed before physics-post) still deliver to the surviving shape with a valid
 * `other: Entity` reference. */
function _emitContact(
  state: PhysicsState,
  touched: Set<number>,
  selfHandle: Handle,
  selfEid: number,
  otherEid: number,
  kind: "begin" | "end"
): void {
  // Guard against slot reuse: if the generation was bumped AND a NEW shape
  // allocated this slot within the same step, skip (stale event).
  if (!state.shapes.idPool.isValid(selfHandle as never)) {
    return;
  }
  // Use the eid captured at emit time — shapeEntityByEid persists the Entity
  // object even after the entity has been destroyed and unregistered from the world.
  const selfEntity = state.shapeEntityByEid.get(selfEid);
  if (selfEntity === undefined) {
    return;
  }
  const selfEvents = selfEntity.get(ContactEvents) as ContactEvents | undefined;
  if (selfEvents === undefined) {
    return; // not opted in (or destroyed before component was removed)
  }

  const otherEntity = state.shapeEntityByEid.get(otherEid);
  if (otherEntity === undefined) {
    return;
  }

  if (!touched.has(selfEid)) {
    // First touch this step: clear arrays in place (preserves user's reference).
    selfEvents.begin.length = 0;
    selfEvents.end.length = 0;
    touched.add(selfEid);
  }

  if (kind === "begin") {
    selfEvents.begin.push({ other: otherEntity });
  } else {
    selfEvents.end.push({ other: otherEntity });
  }
}

/** Emit a sensor event to the sensor shape's `SensorEvents` component.
 * Only the sensor side receives; the visitor does not. */
function _emitSensor(
  state: PhysicsState,
  touched: Set<number>,
  sensorHandle: Handle,
  sensorEid: number,
  visitorEid: number,
  kind: "begin" | "end"
): void {
  if (!state.shapes.idPool.isValid(sensorHandle as never)) {
    return;
  }
  const sensorEntity = state.shapeEntityByEid.get(sensorEid);
  if (sensorEntity === undefined) {
    return;
  }
  const sensorEvents = sensorEntity.get(SensorEvents) as SensorEvents | undefined;
  if (sensorEvents === undefined) {
    return; // sensor not opted in
  }

  const visitorEntity = state.shapeEntityByEid.get(visitorEid);
  if (visitorEntity === undefined) {
    return;
  }

  if (!touched.has(sensorEid)) {
    sensorEvents.begin.length = 0;
    sensorEvents.end.length = 0;
    touched.add(sensorEid);
  }

  if (kind === "begin") {
    sensorEvents.begin.push({ other: visitorEntity });
  } else {
    sensorEvents.end.push({ other: visitorEntity });
  }
}

/** Emit one side of a hit event.
 * The A→B normal from `ev` is used for both sides without flipping. */
function _emitHit(
  state: PhysicsState,
  touched: Set<number>,
  selfHandle: Handle,
  selfEid: number,
  otherEid: number,
  ev: ContactHitEvent
): void {
  if (!state.shapes.idPool.isValid(selfHandle as never)) {
    return;
  }
  const selfEntity = state.shapeEntityByEid.get(selfEid);
  if (selfEntity === undefined) {
    return;
  }
  const selfEvents = selfEntity.get(HitEvents) as HitEvents | undefined;
  if (selfEvents === undefined) {
    return; // not opted in
  }

  const otherEntity = state.shapeEntityByEid.get(otherEid);
  if (otherEntity === undefined) {
    return;
  }

  if (!touched.has(selfEid)) {
    selfEvents.hits.length = 0;
    touched.add(selfEid);
  }

  selfEvents.hits.push({
    other: otherEntity,
    x: ev.pointX,
    y: ev.pointY,
    normalX: ev.normalX,
    normalY: ev.normalY,
    speed: ev.approachSpeed,
  });
}
