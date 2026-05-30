// The collide pass (VP-18): narrow-phase contact update + contact state changes.
//
// Ports box2d v3.2.0's `b2Collide` (physics_world.c:610-815) and its worker
// `b2CollideTask` (physics_world.c:428-581), collapsed to a single serial pass
// (no parallel-for, no per-worker bitsets). Also ports the pair-creation
// callback `b2PairQueryCallback`'s shape filtering (broad_phase.c:172-264) — the
// broad phase no longer filters (VP-18), so the filter lives here in the
// contact-create callback — and `b2AddNonTouchingContact` /
// `b2RemoveNonTouchingContact` (physics_world.c:583-607).
//
// Flow per step (called by `engineStep` between updatePairs and solve):
//   1. updatePairs(pairCreateCallback) — already invoked by the orchestrator;
//      `pairCreateCallback` here filters + creates contacts.
//   2. collide(state, ctx):
//      a. Gather all contact sims (touching graph + non-touching awake set).
//      b. For each: AABB-overlap / disjoint check, refresh body indices +
//         masses, build transforms, b2UpdateContact, set started/stopped flags,
//         copy baseSeparation. Track contacts whose touch-state changed by id.
//      c. Serially process the state-changed contacts: destroy disjoint,
//         link + move newly-touching into the graph, unlink + move
//         newly-non-touching back to the awake set.
//
// Deferred (commented at each site): contact recycling (recycleDistance = 0,
// v1), the bullet / isFast speculative nudge (M5 CCD), and the begin/end
// contact ECS events (M4 / VP-21).
//
// Engine module boundary: imports only from math/, util/, and sibling engine/.

import { rotateVector } from "../math/rot.js";
import type { Transform } from "../math/transform.js";
import { swapRemove } from "../util/dense_array.js";
import { NULL_INDEX } from "../util/handle.js";

import { STATIC_BODY } from "./body.js";
import {
  addContactToGraph,
  createContact,
  destroyContact,
  removeContactFromGraph,
  shouldShapesCollide,
  updateContact,
  CONTACT_ENABLE_CONTACT_EVENTS,
  CONTACT_TOUCHING_FLAG,
  SIM_DISJOINT,
  SIM_STARTED_TOUCHING,
  SIM_STOPPED_TOUCHING,
  SIM_TOUCHING_FLAG,
  type ContactSim,
  type InternalContact,
} from "./contact.js";
import { linkContact, unlinkContact } from "./island.js";
import { AWAKE_SET } from "./solver_set.js";
import type { StepContext } from "./solver.js";
import type { ContactTouchEvent, PhysicsState } from "./state.js";

// ─── pairCreateCallback (b2PairQueryCallback shape filtering) ─────────────────

/**
 * The broad-phase pair-creation callback. Ports the shape filtering of
 * `b2PairQueryCallback` (broad_phase.c:243-270) that the broad phase no longer
 * does (VP-18): same-body skip, sensor skip (sensors are M4), and
 * `b2ShouldShapesCollide`. When the pair passes, {@link createContact} does the
 * remaining `b2CanCollide` check, canonical ordering, and the `addPair`.
 *
 * Returns a closure bound to `state` so it can be passed straight to
 * `broadPhase.updatePairs`.
 */
export function makePairCreateCallback(state: PhysicsState): (a: number, b: number) => void {
  return (shapeIndexA: number, shapeIndexB: number): void => {
    const shapeA = state.shapes.get(shapeIndexA);
    const shapeB = state.shapes.get(shapeIndexB);

    // Are the shapes on the same body?
    if (shapeA.bodyHandle.index === shapeB.bodyHandle.index) {
      return;
    }

    // Sensors are handled elsewhere (M4). A sensor never makes a solid contact.
    if (shapeA.sensor || shapeB.sensor) {
      return;
    }

    // Collision filter.
    if (!shouldShapesCollide(shapeA, shapeB)) {
      return;
    }

    // b2ShouldBodiesCollide (joints) and the custom user filter are out of
    // scope (no joints in v1, no custom filter). createContact does the
    // b2CanCollide type-pair check, canonical ordering, and the addPair.
    createContact(state, shapeIndexA, shapeIndexB);
  };
}

// ─── _addNonTouchingContact (b2AddNonTouchingContact) ─────────────────────────

/** Push a now-non-touching contact's sim into the awake set's `contactSims`
 * (its non-touching home), setting `colorIndex = NULL_INDEX` and a fresh
 * `localIndex`. Ports `b2AddNonTouchingContact` (physics_world.c:583). The sim
 * object reference is reused (move-the-reference, see contact.ts header); the
 * caller removes it from the graph color afterward. */
function _addNonTouchingContact(
  state: PhysicsState,
  contact: InternalContact,
  contactSim: ContactSim
): void {
  const awakeSet = state.solverSets[AWAKE_SET]!;
  contact.colorIndex = NULL_INDEX;
  contact.localIndex = awakeSet.contactSims.length;
  awakeSet.contactSims.push(contactSim);
}

// ─── collide (b2Collide) ──────────────────────────────────────────────────────

/**
 * Run the narrow-phase update over every contact and process the resulting
 * touch-state changes. Ports `b2Collide` (physics_world.c:610) serialised:
 * gather → per-contact update (`b2CollideTask`) → serial state-change loop.
 */
export function collide(state: PhysicsState, _ctx: StepContext): void {
  const awakeSet = state.solverSets[AWAKE_SET]!;

  // ── Gather all contact sims into one list (b2Collide:618-659) ──────────────
  // Touching contacts live in the single overflow graph color; non-touching
  // ones in the awake set's contactSims.
  const contactSims: ContactSim[] = [];
  for (const sim of state.graphContactSims) {
    contactSims.push(sim);
  }
  for (const sim of awakeSet.contactSims) {
    contactSims.push(sim);
  }

  if (contactSims.length === 0) {
    return;
  }

  // Contacts whose touch state changed this step, tracked by contact id (sims
  // move between arrays so ids are stable; mirrors box2d's contactStateBitSet).
  // Iterating the gathered sims in order keeps this deterministic.
  const stateChanged = new Set<number>();

  // ── Per-contact narrow-phase update (b2CollideTask:445-578) ────────────────
  for (const contactSim of contactSims) {
    const contactId = contactSim.contactId;

    const shapeA = state.shapes.get(contactSim.shapeIdA);
    const shapeB = state.shapes.get(contactSim.shapeIdB);

    // Do proxies still overlap? (b2AABB_Overlaps on the fat AABBs.)
    const overlap =
      shapeA.fatAabbMinX <= shapeB.fatAabbMaxX &&
      shapeA.fatAabbMinY <= shapeB.fatAabbMaxY &&
      shapeB.fatAabbMinX <= shapeA.fatAabbMaxX &&
      shapeB.fatAabbMinY <= shapeA.fatAabbMaxY;

    if (!overlap) {
      contactSim.simFlags |= SIM_DISJOINT;
      contactSim.simFlags &= ~SIM_TOUCHING_FLAG;
      stateChanged.add(contactId);
      continue;
    }

    const wasTouching = (contactSim.simFlags & SIM_TOUCHING_FLAG) !== 0;

    const bodyA = state.bodies.get(shapeA.bodyHandle.index);
    const bodyB = state.bodies.get(shapeB.bodyHandle.index);
    const bodySimA = state.solverSets[bodyA.setIndex]!.bodySims[bodyA.localIndex]!;
    const bodySimB = state.solverSets[bodyB.setIndex]!.bodySims[bodyB.localIndex]!;

    // Refresh transient body indices + inverse masses every step so they never
    // go stale across body swap-pops (b2CollideTask:475-481).
    contactSim.bodySimIndexA = bodyA.setIndex === AWAKE_SET ? bodyA.localIndex : NULL_INDEX;
    contactSim.invMassA = bodySimA.invMass;
    contactSim.invIA = bodySimA.invInertia;
    contactSim.bodySimIndexB = bodyB.setIndex === AWAKE_SET ? bodyB.localIndex : NULL_INDEX;
    contactSim.invMassB = bodySimB.invMass;
    contactSim.invIB = bodySimB.invInertia;

    // Contact recycling (b2CollideTask:483-538) is disabled in v1
    // (recycleDistance = 0); the cached-transform fields are omitted.
    // The bullet / isFast speculative nudge (b2CollideTask:565-576) is M5 CCD.

    const xfA: Transform = {
      p: { x: bodySimA.transformX, y: bodySimA.transformY },
      q: { c: bodySimA.cos, s: bodySimA.sin },
    };
    const xfB: Transform = {
      p: { x: bodySimB.transformX, y: bodySimB.transformY },
      q: { c: bodySimB.cos, s: bodySimB.sin },
    };
    const centerOffsetA = rotateVector(xfA.q, {
      x: bodySimA.localCenterX,
      y: bodySimA.localCenterY,
    });
    const centerOffsetB = rotateVector(xfB.q, {
      x: bodySimB.localCenterX,
      y: bodySimB.localCenterY,
    });

    const touching = updateContact(
      state,
      contactSim,
      shapeA,
      xfA,
      centerOffsetA,
      shapeB,
      xfB,
      centerOffsetB
    );

    // State changes that affect island connectivity (b2CollideTask:548-557).
    if (touching && !wasTouching) {
      contactSim.simFlags |= SIM_STARTED_TOUCHING;
      stateChanged.add(contactId);
    } else if (!touching && wasTouching) {
      contactSim.simFlags |= SIM_STOPPED_TOUCHING;
      stateChanged.add(contactId);
    }

    // baseSeparation snapshot, after updateContact (b2CollideTask:559-563).
    const manifold = contactSim.manifold;
    for (let i = 0; i < manifold.pointCount; i++) {
      const mp = manifold.points[i]!;
      mp.baseSeparation = mp.separation;
    }
  }

  // ── Serial state-change processing (b2Collide:697-808) ─────────────────────
  // Box2D processes the changed contacts in ASCENDING contact-id order: it walks
  // a `contactStateBitSet` block by block, peeling the lowest set bit with
  // `b2CTZ64` (`contactId = 64*k + ctz`). Our `stateChanged` Set iterates in
  // insertion (gather) order, which is graph-array order then awake-set order —
  // and once sims have swap-moved between those arrays the gather order no longer
  // matches ascending id. The loop mutates `graphContactSims`/`contactSims` (adds
  // to graph, removes from awake, destroys), so a different processing order
  // yields a different post-loop array order, and the solver iterates
  // `graphContactSims` in array order → divergent (but still self-consistent)
  // numeric results. Sort to recover Box2D's id order and keep step-to-step
  // parity. Ids are small ints; the per-step changed set is tiny.
  const changedInOrder = [...stateChanged].sort((a, b) => a - b);
  for (const contactId of changedInOrder) {
    const contact = state.contacts.records[contactId];
    if (contact === undefined) {
      // Already destroyed earlier in this loop (cannot happen with distinct
      // ids, but guards against a double-process).
      continue;
    }

    const colorIndex = contact.colorIndex;
    const localIndex = contact.localIndex;

    // Resolve the current sim: touching → graph color, else awake set.
    let contactSim: ContactSim;
    if (colorIndex !== NULL_INDEX) {
      contactSim = state.graphContactSims[localIndex]!;
    } else {
      contactSim = awakeSet.contactSims[localIndex]!;
    }

    const simFlags = contactSim.simFlags;

    if (simFlags & SIM_DISJOINT) {
      // Bounding boxes no longer overlap.
      destroyContact(state, contact, false);
    } else if (simFlags & SIM_STARTED_TOUCHING) {
      // Emit a begin-touch event when either shape opted in (VP-21a).
      // Mirrors b2Collide (physics_world.c:749-753):
      //   if ( flags & b2_contactEnableContactEvents )
      //     b2ContactBeginTouchEvent event = { shapeIdA, shapeIdB, contactFullId };
      //     b2Array_Push( world->contactBeginEvents, event );
      // Note: SIM_DISJOINT → destroyContact (above) fires its own end event,
      // so we do NOT emit here for the disjoint branch — destroyContact covers it.
      if (contact.flags & CONTACT_ENABLE_CONTACT_EVENTS) {
        state.contactBeginEvents.push(_makeContactTouchEvent(state, contact));
      }

      // Link first because this ensures the body sims are in the correct place
      // (b2Collide:758-761).
      contact.flags |= CONTACT_TOUCHING_FLAG;
      linkContact(state, contact);

      // The sim pointer may have moved due to awake-set growth — re-fetch by
      // localIndex (b2Collide:767-769). With move-the-reference our object
      // identity is stable, but the array slot is the source of truth.
      contactSim = awakeSet.contactSims[localIndex]!;
      contactSim.simFlags &= ~SIM_STARTED_TOUCHING;

      // Add to the graph first (pushes the sim into graphContactSims), then
      // remove the now-moved non-touching sim from the awake set
      // (b2Collide:773-777).
      addContactToGraph(state, contactSim, contact);
      _removeNonTouchingContact(state, localIndex);
    } else if (simFlags & SIM_STOPPED_TOUCHING) {
      contactSim.simFlags &= ~SIM_STOPPED_TOUCHING;
      contact.flags &= ~CONTACT_TOUCHING_FLAG;

      // Emit an end-touch event when either shape opted in (VP-21a).
      // Mirrors b2Collide (physics_world.c:786-790):
      //   if ( contact->flags & b2_contactEnableContactEvents )
      //     b2ContactEndTouchEvent event = { shapeIdA, shapeIdB, contactFullId };
      //     b2Array_Push( world->contactEndEvents[endEventArrayIndex], event );
      if (contact.flags & CONTACT_ENABLE_CONTACT_EVENTS) {
        state.contactEndEvents.push(_makeContactTouchEvent(state, contact));
      }

      unlinkContact(state, contact);

      // Add to the awake set's contactSims first, then remove from the graph
      // (b2Collide:794-800) — add-before-remove (box2d's "Add first for
      // memcpy"). `localIndex` here is the graph-color index.
      _addNonTouchingContact(state, contact, contactSim);
      removeContactFromGraph(state, localIndex);
    }
  }
}

/** Build a {@link ContactTouchEvent} from `contact`'s canonical shape indices.
 * Retrieves the current generation for each shape index from the id pool so the
 * handle is valid at emit time (VP-21a). VP-21b resolves with `IdPool.isValid`
 * to skip any handle whose shape was destroyed after this step. */
function _makeContactTouchEvent(state: PhysicsState, contact: InternalContact): ContactTouchEvent {
  const pool = state.shapes.idPool;
  const eA = state.shapes.records[contact.shapeIdA]?.entity ?? -1;
  const eB = state.shapes.records[contact.shapeIdB]?.entity ?? -1;
  return {
    shapeA: { index: contact.shapeIdA, generation: pool.generationOf(contact.shapeIdA) },
    shapeB: { index: contact.shapeIdB, generation: pool.generationOf(contact.shapeIdB) },
    entityEidA: eA,
    entityEidB: eB,
  };
}

/** Swap-remove the non-touching sim at `localIndex` from the awake set's
 * `contactSims`, repairing the moved sim's owning contact `localIndex`. Ports
 * `b2RemoveNonTouchingContact` (physics_world.c:594) for the awake set. */
function _removeNonTouchingContact(state: PhysicsState, localIndex: number): void {
  const sims = state.solverSets[AWAKE_SET]!.contactSims;
  const moved = swapRemove(sims, localIndex);
  if (moved !== undefined) {
    state.contacts.get(moved.contactId).localIndex = localIndex;
  }
}
