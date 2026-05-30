// Contact data model + storage + create/destroy bookkeeping (VP-15a).
//
// Ports the cold/hot contact split from box2d/src/contact.{h,c}:
//   - b2ContactEdge / b2Contact   -> ContactEdge / InternalContact (cold)
//   - b2ContactSim                -> ContactSim (hot)
//   - b2ContactFlags              -> the v1 subset of named flag constants
//   - b2CreateContact             -> createContact (bookkeeping; NOT the
//                                    narrow-phase manifold update, which is VP-15b)
//   - b2DestroyContact            -> destroyContact
//   - b2ShouldShapesCollide       -> shouldShapesCollide (shape.h:118)
//   - b2MixFriction/Restitution   -> the default friction/restitution callbacks
//                                    (physics_world.c:97/103)
//
// This file lands the SHARED M3 data model. The narrow-phase manifold refresh
// (`b2UpdateContact`, VP-15b), islands (VP-16), and the solver (VP-17) build on
// what is here.
//
// Box2D split InternalContact (cold, organisational) from ContactSim (hot,
// solver) exactly as body.ts splits InternalBody from BodySim. As in body.ts,
// sims relocate between arrays by moving the object reference (swap-pop fixes
// the moved element's `localIndex`); the IdPool owns generations, so the cold
// record drops box2d's `generation` field.
//
// Engine module boundary: imports only from math/, util/, and sibling engine/.

import type { Transform } from "../math/transform.js";
import type { Vec2 } from "../math/vec2.js";
import { swapRemove } from "../util/dense_array.js";
import { NULL_INDEX, type ContactHandle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";

import { STATIC_BODY } from "./body.js";
import {
  emptyManifold,
  emptySimplexCache,
  type Manifold,
  type SimplexCache,
} from "./manifold/types.js";
import { unlinkContact } from "./island.js";
import { canCollide, computeManifold, isPrimaryPair } from "./narrow_phase.js";
import type { InternalShape } from "./shape.js";
import { AWAKE_SET, DISABLED_SET, FIRST_SLEEPING_SET, type SolverSet } from "./solver_set.js";
import type { ContactTouchEvent, PhysicsState } from "./state.js";

// ─── Contact flags (subset of b2ContactFlags, contact.h:15) ───────────────────
//
// Values quoted verbatim from box2d's enum. The recycle / pre-solve /
// relative-transform flags are out of scope for v1.

/** Set when the solid shapes are touching. Mirrors `b2_contactTouchingFlag`. */
export const CONTACT_TOUCHING_FLAG = 0x00000001;
/** This contact wants contact events. Mirrors `b2_contactEnableContactEvents`. */
export const CONTACT_ENABLE_CONTACT_EVENTS = 0x00000004;
/** Set when the shapes are touching (sim copy). Mirrors `b2_simTouchingFlag`. */
export const SIM_TOUCHING_FLAG = 0x00010000;
/** This contact no longer has overlapping AABBs. Mirrors `b2_simDisjoint`. */
export const SIM_DISJOINT = 0x00020000;
/** This contact started touching this step. Mirrors `b2_simStartedTouching`. */
export const SIM_STARTED_TOUCHING = 0x00040000;
/** This contact stopped touching this step. Mirrors `b2_simStoppedTouching`. */
export const SIM_STOPPED_TOUCHING = 0x00080000;
/** This contact has a hit event. Mirrors `b2_simEnableHitEvent`. */
export const SIM_ENABLE_HIT_EVENT = 0x00100000;

// ─── OVERFLOW_COLOR ───────────────────────────────────────────────────────────

/** The single graph-color index for touching contacts. v1 has no graph
 * coloring (box2d's `B2_FORCE_OVERFLOW` path), so every touching contact lives
 * in the one overflow color (`state.graphContactSims`). A contact's
 * `colorIndex` is {@link OVERFLOW_COLOR} when touching and {@link NULL_INDEX}
 * when non-touching or free. See PROGRESS.md → MILESTONE 3 decision. */
export const OVERFLOW_COLOR = 0;

// ─── ContactEdge ──────────────────────────────────────────────────────────────

/** A node in a body's intrusive doubly-linked contact list. Each contact has
 * two edges, one per attached body. `prevKey`/`nextKey` are encoded
 * `(contactId << 1) | edge` keys (or {@link NULL_INDEX}); `bodyId` is a body
 * handle index. Mirrors `b2ContactEdge`. */
export interface ContactEdge {
  bodyId: number;
  prevKey: number;
  nextKey: number;
}

// ─── InternalContact (cold) ───────────────────────────────────────────────────

/** Sparse, organisational contact record. Indexed by a {@link ContactHandle}'s
 * index; the solver does not read it. Mirrors `b2Contact` minus the
 * `generation` field (the {@link IdPool} owns generations). */
export interface InternalContact {
  /** The two body→contact linked-list nodes (one per attached body). */
  edges: [ContactEdge, ContactEdge];
  /** Island this contact belongs to (touching only), or {@link NULL_INDEX}.
   * Populated by VP-16. Mirrors `b2Contact.islandId`. */
  islandId: number;
  /** Index within the island's contacts array, or {@link NULL_INDEX}.
   * Populated by VP-16. Mirrors `b2Contact.islandIndex`. */
  islandIndex: number;
  /** Solver set this contact's sim lives in, or {@link NULL_INDEX} when free.
   * Mirrors `b2Contact.setIndex`. */
  setIndex: number;
  /** Graph color index ({@link OVERFLOW_COLOR} when touching, else
   * {@link NULL_INDEX}). Mirrors `b2Contact.colorIndex`. */
  colorIndex: number;
  /** Index of this contact's sim within its set or graph color.
   * {@link NULL_INDEX} when free. Mirrors `b2Contact.localIndex`. */
  localIndex: number;
  /** Canonical (primary-order) shape handle index, side A. */
  shapeIdA: number;
  /** Canonical (primary-order) shape handle index, side B. */
  shapeIdB: number;
  /** This contact's own handle index. {@link NULL_INDEX} when free. */
  contactId: number;
  /** b2ContactFlags bitset. */
  flags: number;
}

// ─── ContactSim (hot) ─────────────────────────────────────────────────────────

/** Dense per-contact simulation data. One per contact, living either in a
 * solver set's `contactSims` (non-touching) or in `state.graphContactSims`
 * (touching). Mirrors `b2ContactSim`. The `cachedTransformA/B` fields are
 * omitted (contact recycling is disabled in v1); the `B2_ENABLE_VALIDATION`
 * `bodyIdA/B` debug fields are omitted. */
export interface ContactSim {
  contactId: number;
  /** Transient body-sim indices, refreshed each step by the collide pass.
   * {@link NULL_INDEX} until then. Mirrors `b2ContactSim.bodySimIndexA/B`. */
  bodySimIndexA: number;
  bodySimIndexB: number;
  shapeIdA: number;
  shapeIdB: number;
  invMassA: number;
  invIA: number;
  invMassB: number;
  invIB: number;
  manifold: Manifold;
  /** Mixed friction. */
  friction: number;
  /** Mixed restitution. */
  restitution: number;
  rollingResistance: number;
  tangentSpeed: number;
  /** b2ContactFlags bitset (sim copy). Mirrors `b2ContactSim.simFlags`. */
  simFlags: number;
  cache: SimplexCache;
}

// ─── ContactStorage ───────────────────────────────────────────────────────────

/** Owns the sparse {@link InternalContact} table and the index allocator that
 * hands out contact handles. Mirrors {@link BodyStorage} / {@link ShapeStorage}. */
export class ContactStorage {
  /** Sparse, indexed by a {@link ContactHandle}'s index; `undefined` = freed. */
  public readonly records: (InternalContact | undefined)[] = [];

  /** Allocates contact handle indices, stamping each with a generation. */
  public readonly idPool = new IdPool<ContactHandle>();

  /** Live contact at a handle index. Throws if the slot is empty. */
  public get(index: number): InternalContact {
    const contact = this.records[index];
    if (contact === undefined) {
      throw new Error(`no contact at index ${index}`);
    }
    return contact;
  }
}

// ─── Factories ────────────────────────────────────────────────────────────────

/** A non-touching {@link ContactSim} with zeroed solver fields and an empty
 * manifold, back-pointing at `contactId`. Mirrors the `b2ContactSim`
 * initialisation in `b2CreateContact` (contact.c:341-358). Friction /
 * restitution are seeded by {@link createContact} via the mixing rules. */
export function makeContactSim(contactId: number): ContactSim {
  return {
    contactId,
    bodySimIndexA: NULL_INDEX,
    bodySimIndexB: NULL_INDEX,
    shapeIdA: NULL_INDEX,
    shapeIdB: NULL_INDEX,
    invMassA: 0,
    invIA: 0,
    invMassB: 0,
    invIB: 0,
    manifold: emptyManifold(),
    friction: 0,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    simFlags: 0,
    cache: emptySimplexCache(),
  };
}

/** Allocate a zeroed {@link InternalContact} for a free slot (mirrors
 * `(b2Contact){ 0 }` then the field writes in `b2CreateContact`). All indices
 * start {@link NULL_INDEX}; the caller fills them in. */
function makeInternalContact(): InternalContact {
  return {
    edges: [
      { bodyId: NULL_INDEX, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
      { bodyId: NULL_INDEX, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
    ],
    islandId: NULL_INDEX,
    islandIndex: NULL_INDEX,
    setIndex: NULL_INDEX,
    colorIndex: NULL_INDEX,
    localIndex: NULL_INDEX,
    shapeIdA: NULL_INDEX,
    shapeIdB: NULL_INDEX,
    contactId: NULL_INDEX,
    flags: 0,
  };
}

// ─── Mixing rules (default friction/restitution callbacks) ───────────────────

/** Mix two friction coefficients. Mirrors `b2DefaultFrictionCallback`
 * (physics_world.c:97): `sqrtf( frictionA * frictionB )`. */
export function mixFriction(frictionA: number, frictionB: number): number {
  return Math.sqrt(frictionA * frictionB);
}

/** Mix two restitution coefficients. Mirrors `b2DefaultRestitutionCallback`
 * (physics_world.c:103): `b2MaxFloat( restitutionA, restitutionB )`. */
export function mixRestitution(restitutionA: number, restitutionB: number): number {
  return Math.max(restitutionA, restitutionB);
}

// ─── shouldShapesCollide ──────────────────────────────────────────────────────

interface Filter {
  categoryBits: number;
  maskBits: number;
  groupIndex: number;
}

/** Whether two shapes' collision filters permit a contact. Ports
 * `b2ShouldShapesCollide` (shape.h:118): a matching non-zero group index
 * decides by sign (positive → always, negative → never); otherwise the
 * category/mask masks must intersect both ways. The 32-bit `number` filter
 * fields replace box2d's `uint64_t` (settled VP-3). */
export function shouldShapesCollide(filterA: Filter, filterB: Filter): boolean {
  if (filterA.groupIndex === filterB.groupIndex && filterA.groupIndex !== 0) {
    return filterA.groupIndex > 0;
  }
  return (
    (filterA.maskBits & filterB.categoryBits) !== 0 &&
    (filterA.categoryBits & filterB.maskBits) !== 0
  );
}

// ─── Linked-list key helpers ──────────────────────────────────────────────────

/** Encode a `(contactId, edge)` pair into a contact-list key. Mirrors box2d's
 * `(contactId << 1) | edge`. */
function makeContactKey(contactId: number, edge: number): number {
  return (contactId << 1) | edge;
}

// ─── createContact (b2CreateContact bookkeeping) ──────────────────────────────

/**
 * Create a contact between the shapes at handle indices `shapeIndexA` /
 * `shapeIndexB`. Ports the bookkeeping of `b2CreateContact` (contact.c:224):
 * canonical ordering via the narrow-phase registry, the cold
 * {@link InternalContact} + its two edges linked into both bodies' contact
 * lists, a non-touching {@link ContactSim} pushed into the target set's
 * `contactSims`, the pair key added to the broad phase, and friction /
 * restitution seeded via the mixing rules.
 *
 * The narrow-phase manifold refresh (`b2UpdateContact`) is VP-15b; the contact
 * is created non-touching with `colorIndex = NULL_INDEX`.
 */
export function createContact(state: PhysicsState, shapeIndexA: number, shapeIndexB: number): void {
  let shapeA = state.shapes.get(shapeIndexA);
  let shapeB = state.shapes.get(shapeIndexB);

  // No collide fn for this type pair (e.g. segment–segment): no contact.
  if (!canCollide(shapeA.type, shapeB.type)) {
    return;
  }

  // Store shapes in canonical (primary) order so the narrow phase always calls
  // computeManifold in that order (mirrors b2CreateContact's recursive flip).
  if (!isPrimaryPair(shapeA.type, shapeB.type)) {
    [shapeIndexA, shapeIndexB] = [shapeIndexB, shapeIndexA];
    [shapeA, shapeB] = [shapeB, shapeA];
  }

  const bodyA = state.bodies.get(shapeA.bodyHandle.index);
  const bodyB = state.bodies.get(shapeB.bodyHandle.index);

  // Set placement: awake if either body is awake, else the disabled set (where
  // sleeping/non-touching contacts live). With no sleep in M3, a dynamic body
  // is always in the awake set, so a contact involving one is awake.
  const setIndex =
    bodyA.setIndex === AWAKE_SET || bodyB.setIndex === AWAKE_SET ? AWAKE_SET : DISABLED_SET;
  const set = state.solverSets[setIndex]!;

  // Allocate the cold record.
  const handle = state.contacts.idPool.allocate();
  const contactId = handle.index;
  const contact = makeInternalContact();
  state.contacts.records[contactId] = contact;

  contact.contactId = contactId;
  contact.setIndex = setIndex;
  contact.colorIndex = NULL_INDEX;
  contact.localIndex = set.contactSims.length;
  contact.islandId = NULL_INDEX;
  contact.islandIndex = NULL_INDEX;
  contact.shapeIdA = shapeIndexA;
  contact.shapeIdB = shapeIndexB;
  contact.flags = 0;

  if (shapeA.enableContactEvents || shapeB.enableContactEvents) {
    contact.flags |= CONTACT_ENABLE_CONTACT_EVENTS;
  }

  // Connect to body A (edge 0).
  {
    const edge = contact.edges[0];
    edge.bodyId = shapeA.bodyHandle.index;
    edge.prevKey = NULL_INDEX;
    edge.nextKey = bodyA.headContactKey;
    const keyA = makeContactKey(contactId, 0);
    if (bodyA.headContactKey !== NULL_INDEX) {
      const headContact = state.contacts.get(bodyA.headContactKey >> 1);
      headContact.edges[bodyA.headContactKey & 1]!.prevKey = keyA;
    }
    bodyA.headContactKey = keyA;
    bodyA.contactCount += 1;
  }

  // Connect to body B (edge 1).
  {
    const edge = contact.edges[1];
    edge.bodyId = shapeB.bodyHandle.index;
    edge.prevKey = NULL_INDEX;
    edge.nextKey = bodyB.headContactKey;
    const keyB = makeContactKey(contactId, 1);
    if (bodyB.headContactKey !== NULL_INDEX) {
      const headContact = state.contacts.get(bodyB.headContactKey >> 1);
      headContact.edges[bodyB.headContactKey & 1]!.prevKey = keyB;
    }
    bodyB.headContactKey = keyB;
    bodyB.contactCount += 1;
  }

  // Add to the broad-phase pair set for fast lookup (pairSet membership now
  // means "a contact exists"). Mirrors b2AddKey( &broadPhase.pairSet, ... ).
  state.broadPhase.addPair(shapeIndexA, shapeIndexB);

  // Contacts are created non-touching; if later found touching they link
  // islands and move into the constraint graph (VP-15b/VP-16/VP-17).
  const sim = makeContactSim(contactId);
  sim.shapeIdA = shapeIndexA;
  sim.shapeIdB = shapeIndexB;
  sim.friction = mixFriction(shapeA.friction, shapeB.friction);
  sim.restitution = mixRestitution(shapeA.restitution, shapeB.restitution);
  sim.simFlags = contact.flags;
  set.contactSims.push(sim);
}

// ─── destroyContact (b2DestroyContact bookkeeping) ────────────────────────────

/**
 * Destroy `contact`. Ports the bookkeeping of `b2DestroyContact`
 * (contact.c:382): remove the broad-phase pair key, unlink both edges from
 * their bodies' contact lists (fixing prev/next/head and decrementing
 * `contactCount`), then swap-remove the {@link ContactSim} from whichever array
 * owns it — the overflow graph color (`state.graphContactSims`) when touching,
 * else the contact's solver set's `contactSims` — repairing the moved sim's
 * `localIndex`. Finally frees the contact id.
 *
 * `wakeBodies` is accepted for parity; the `b2WakeBody` calls are sleep (M5)
 * and are skipped here. The end-touch ECS event is M4 (VP-21) and is skipped.
 */
export function destroyContact(
  state: PhysicsState,
  contact: InternalContact,
  wakeBodies: boolean
): void {
  // Remove the pair key from the broad phase so the pair can re-emit if the
  // shapes re-overlap.
  state.broadPhase.removePair(contact.shapeIdA, contact.shapeIdB);

  const edgeA = contact.edges[0];
  const edgeB = contact.edges[1];
  const bodyA = state.bodies.get(edgeA.bodyId);
  const bodyB = state.bodies.get(edgeB.bodyId);

  // Capture touching flag before clearing (b2DestroyContact, contact.c:395).
  const touching = (contact.flags & CONTACT_TOUCHING_FLAG) !== 0;

  // Emit an end-touch event when the contact was touching and either shape
  // opted in (VP-21a). Mirrors b2DestroyContact (contact.c:400-422):
  //   bool touching = ( flags & b2_contactTouchingFlag ) != 0;
  //   if ( touching && ( flags & b2_contactEnableContactEvents ) != 0 )
  //     b2ContactEndTouchEvent event = { shapeIdA, shapeIdB, contactId };
  //     b2Array_Push( world->contactEndEvents[world->endEventArrayIndex], event );
  // This covers disjoint-destroy (SIM_DISJOINT path in collide.ts — see note
  // there: disjoint calls destroyContact directly, so only this site emits the
  // end event for that path), shape removal, body destroy, and filter-change
  // teardown. The SIM_STOPPED_TOUCHING path in collide.ts does NOT call
  // destroyContact — it emits its own end event, clears CONTACT_TOUCHING_FLAG,
  // and moves the contact to the awake set as non-touching (the contact
  // persists). If that contact later becomes SIM_DISJOINT and destroyContact
  // runs, the CONTACT_TOUCHING_FLAG guard below is already false, so this site
  // naturally does NOT double-emit.
  {
    const flags = contact.flags;
    if (touching && (flags & CONTACT_ENABLE_CONTACT_EVENTS) !== 0) {
      const pool = state.shapes.idPool;
      // Capture entity eids NOW (before the shape records may be freed later in
      // the same physics-pre pass). VP-21b uses the eid to look up the Entity
      // via state.shapeEntityByEid, bypassing the stale-record guard.
      const eA = state.shapes.records[contact.shapeIdA]?.entity ?? -1;
      const eB = state.shapes.records[contact.shapeIdB]?.entity ?? -1;
      const event: ContactTouchEvent = {
        shapeA: { index: contact.shapeIdA, generation: pool.generationOf(contact.shapeIdA) },
        shapeB: { index: contact.shapeIdB, generation: pool.generationOf(contact.shapeIdB) },
        entityEidA: eA,
        entityEidB: eB,
      };
      state.contactEndEvents.push(event);
    }
  }

  const contactId = contact.contactId;

  // Remove from body A's list.
  _unlinkEdge(state, edgeA);
  if (bodyA.headContactKey === makeContactKey(contactId, 0)) {
    bodyA.headContactKey = edgeA.nextKey;
  }
  bodyA.contactCount -= 1;

  // Remove from body B's list.
  _unlinkEdge(state, edgeB);
  if (bodyB.headContactKey === makeContactKey(contactId, 1)) {
    bodyB.headContactKey = edgeB.nextKey;
  }
  bodyB.contactCount -= 1;

  // Remove from the island when touching. Mirrors b2DestroyContact
  // (contact.c:473-476): `if ( contact->islandId != B2_NULL_INDEX ) b2UnlinkContact`.
  if (contact.islandId !== NULL_INDEX) {
    unlinkContact(state, contact);
  }

  if (contact.colorIndex !== NULL_INDEX) {
    // Touching contact: lives in the single overflow graph color. This is the
    // overflow path of b2RemoveContactFromGraph.
    _removeContactSim(state, state.graphContactSims, contact.localIndex);
  } else {
    // Non-touching (or sleeping) contact: lives in its set's contactSims.
    const set: SolverSet = state.solverSets[contact.setIndex]!;
    _removeContactSim(state, set.contactSims, contact.localIndex);
  }

  // Free the contact record and its id (the IdPool bumps the generation).
  contact.contactId = NULL_INDEX;
  contact.setIndex = NULL_INDEX;
  contact.colorIndex = NULL_INDEX;
  contact.localIndex = NULL_INDEX;
  state.contacts.records[contactId] = undefined;
  state.contacts.idPool.free(contactId);

  // b2DestroyContact (contact.c:506-510): wake bodies when the contact was
  // touching. Mirrors: `if (wakeBodies && touching) { b2WakeBody(bodyA); b2WakeBody(bodyB); }`
  // Uses the state._wakeSolverSet hook (set by sleep.ts) to avoid a circular import.
  if (wakeBodies && touching) {
    if (bodyA.setIndex >= FIRST_SLEEPING_SET) {
      state._wakeSolverSet(state, bodyA.setIndex);
    }
    if (bodyB.setIndex >= FIRST_SLEEPING_SET) {
      state._wakeSolverSet(state, bodyB.setIndex);
    }
  }
}

/** Unlink one edge from its body's doubly-linked contact list by patching the
 * neighbouring edges' prev/next keys. Mirrors the prev/next fixups in
 * `b2DestroyContact`. */
function _unlinkEdge(state: PhysicsState, edge: ContactEdge): void {
  if (edge.prevKey !== NULL_INDEX) {
    const prevContact = state.contacts.get(edge.prevKey >> 1);
    prevContact.edges[edge.prevKey & 1]!.nextKey = edge.nextKey;
  }
  if (edge.nextKey !== NULL_INDEX) {
    const nextContact = state.contacts.get(edge.nextKey >> 1);
    nextContact.edges[edge.nextKey & 1]!.prevKey = edge.prevKey;
  }
}

/** Swap-remove the contact sim at `localIndex` from `sims` and repair the moved
 * sim's owning contact `localIndex`. Mirrors the `b2Array_RemoveSwap` +
 * moved-contact fixup in `b2DestroyContact`. */
function _removeContactSim(state: PhysicsState, sims: ContactSim[], localIndex: number): void {
  const moved = swapRemove(sims, localIndex);
  if (moved !== undefined) {
    state.contacts.get(moved.contactId).localIndex = localIndex;
  }
}

// ─── destroyBodyContacts / destroyBodyContactsForShape ────────────────────────

/**
 * Destroy every contact attached to `bodyId`. Mirrors
 * `b2DestroyBodyContacts` (body.c — the helper called from `b2Body_Disable` /
 * `b2Body_SetType`). Robust to swap-remove during the walk: the next key is
 * captured BEFORE calling `destroyContact` (which may swap-remove sims and
 * mutate neighbour edge pointers).
 */
export function destroyBodyContacts(
  state: PhysicsState,
  bodyId: number,
  wakeBodies: boolean
): void {
  const body = state.bodies.get(bodyId);
  let key = body.headContactKey;
  while (key !== NULL_INDEX) {
    const contactId = key >> 1;
    const edgeIndex = key & 1;
    const contact = state.contacts.records[contactId];
    if (contact === undefined) {
      break;
    }
    // Snapshot next key before destroy (destroyContact mutates edge pointers).
    key = contact.edges[edgeIndex]!.nextKey;
    destroyContact(state, contact, wakeBodies);
  }
}

/**
 * Destroy every contact on `bodyId` that references `shapeIndex` (either as
 * shapeIdA or shapeIdB). Mirrors the loop in `b2DestroyShapeInternal`
 * (shape.c:326–339) and `b2ResetProxy` (shape.c:1282–1295). Robust to
 * swap-remove: next key is captured before destroy.
 */
export function destroyBodyContactsForShape(
  state: PhysicsState,
  bodyId: number,
  shapeIndex: number,
  wakeBodies: boolean
): void {
  const body = state.bodies.get(bodyId);
  let key = body.headContactKey;
  while (key !== NULL_INDEX) {
    const contactId = key >> 1;
    const edgeIndex = key & 1;
    const contact = state.contacts.records[contactId];
    if (contact === undefined) {
      break;
    }
    // Snapshot next key before destroy.
    key = contact.edges[edgeIndex]!.nextKey;
    if (contact.shapeIdA === shapeIndex || contact.shapeIdB === shapeIndex) {
      destroyContact(state, contact, wakeBodies);
    }
  }
}

/**
 * Recompute `CONTACT_ENABLE_CONTACT_EVENTS` on every existing contact on
 * `bodyId` that references `shapeIndex`. Unlike `SIM_ENABLE_HIT_EVENT` (which
 * `updateContact` refreshes every step from the shapes' `enableHitEvents`),
 * the contact-events flag lives on the persistent `InternalContact` and is only
 * set at `createContact` time — so a runtime toggle of a shape's
 * `enableContactEvents` must walk its contacts and update them, mirroring
 * box2d's `b2Shape_EnableContactEvents` (shape.c), which sets/clears the flag
 * on each contact in the shape's contact list. The flag is the OR of both
 * shapes' `enableContactEvents`.
 */
export function refreshShapeContactEventFlag(
  state: PhysicsState,
  bodyId: number,
  shapeIndex: number
): void {
  const body = state.bodies.get(bodyId);
  let key = body.headContactKey;
  while (key !== NULL_INDEX) {
    const contactId = key >> 1;
    const edgeIndex = key & 1;
    const contact = state.contacts.records[contactId];
    if (contact === undefined) {
      break;
    }
    key = contact.edges[edgeIndex]!.nextKey;
    if (contact.shapeIdA === shapeIndex || contact.shapeIdB === shapeIndex) {
      const shapeA = state.shapes.records[contact.shapeIdA];
      const shapeB = state.shapes.records[contact.shapeIdB];
      const enabled =
        (shapeA?.enableContactEvents ?? false) || (shapeB?.enableContactEvents ?? false);
      if (enabled) {
        contact.flags |= CONTACT_ENABLE_CONTACT_EVENTS;
      } else {
        contact.flags &= ~CONTACT_ENABLE_CONTACT_EVENTS;
      }
    }
  }
}

// ─── updateContact (b2UpdateContact narrow-phase refresh) ─────────────────────

/** The radius used by the rolling-resistance rule. Mirrors `b2GetShapeRadius`
 * (shape.h:103-116): circle/capsule/polygon return the geometry's `radius`
 * field, segment/chainSegment return 0. */
function _shapeRadius(shape: InternalShape): number {
  const geom = shape.geometry;
  switch (geom.kind) {
    case "circle":
    case "capsule":
    case "polygon":
      return geom.radius;
    default:
      // segment / chainSegment have no radius field.
      return 0;
  }
}

/**
 * Refresh a contact's manifold and touching status. Ports `b2UpdateContact`
 * (contact.c:529-707).
 *
 * Computes the new manifold via {@link computeManifold} (anchors arrive
 * body-origin-relative with a normal A→B; the GJK `cache` is warm-started in
 * place), then:
 * - keeps `friction` / `restitution` (and the rolling-resistance / tangent-speed
 *   derived values) current in case the shape materials changed;
 * - sets/clears `SIM_ENABLE_HIT_EVENT` from the shapes' `enableHitEvents`;
 * - **shifts each new anchor to center-of-mass-relative** (subtracting the
 *   per-side `centerOffset`) and **carries warm-start impulses** from the old
 *   manifold to any new point with a matching `id` (marking it `persisted`);
 * - sets/clears `SIM_TOUCHING_FLAG` and returns whether the shapes touch.
 *
 * The pre-solve, `enableSpeculative`, and custom-event blocks are out of scope
 * (sensors / pre-solve are later milestones). `baseSeparation` and the
 * started/stopped flags are NOT set here — the collide loop (VP-18) sets those,
 * mirroring `b2CollideTask` (not `b2UpdateContact`).
 */
export function updateContact(
  state: PhysicsState,
  contactSim: ContactSim,
  shapeA: InternalShape,
  transformA: Transform,
  centerOffsetA: Vec2,
  shapeB: InternalShape,
  transformB: Transform,
  centerOffsetB: Vec2
): boolean {
  // Save old manifold (contact.c:533).
  const oldManifold = contactSim.manifold;

  // Compute new manifold (contact.c:536-537). computeManifold returns anchors
  // relative to each shape's BODY origin and a normal A→B, mutating the cache
  // in place for GJK warm-starting.
  contactSim.manifold = computeManifold(shapeA, transformA, shapeB, transformB, contactSim.cache);

  // Keep friction/restitution current in case the shape materials changed
  // (contact.c:540-543).
  contactSim.friction = mixFriction(shapeA.friction, shapeB.friction);
  contactSim.restitution = mixRestitution(shapeA.restitution, shapeB.restitution);

  // Rolling resistance (contact.c:545-556): when either shape has rolling
  // resistance, scale the larger coefficient by the larger shape radius.
  if (shapeA.rollingResistance > 0 || shapeB.rollingResistance > 0) {
    const radiusA = _shapeRadius(shapeA);
    const radiusB = _shapeRadius(shapeB);
    const maxRadius = Math.max(radiusA, radiusB);
    contactSim.rollingResistance =
      Math.max(shapeA.rollingResistance, shapeB.rollingResistance) * maxRadius;
  } else {
    contactSim.rollingResistance = 0;
  }

  // Conveyor-belt tangent speed (contact.c:558).
  contactSim.tangentSpeed = shapeA.tangentSpeed + shapeB.tangentSpeed;

  const manifold = contactSim.manifold;
  const pointCount = manifold.pointCount;
  const touching = pointCount > 0;

  // Hit-event flag (contact.c:609-616). Pre-solve / enableSpeculative blocks
  // (contact.c:563-607) are out of scope.
  if (touching && (shapeA.enableHitEvents || shapeB.enableHitEvents)) {
    contactSim.simFlags |= SIM_ENABLE_HIT_EVENT;
  } else {
    contactSim.simFlags &= ~SIM_ENABLE_HIT_EVENT;
  }

  // Carry the rolling impulse across the refresh (contact.c:618-621).
  if (pointCount > 0) {
    manifold.rollingImpulse = oldManifold.rollingImpulse;
  }

  // Match old contact ids to new ids, shift anchors to center-of-mass-relative,
  // and copy stored impulses to warm-start the solver (contact.c:625-660).
  for (let i = 0; i < pointCount; i++) {
    const mp2 = manifold.points[i]!;

    // Shift anchors to be center-of-mass relative.
    mp2.anchorA = { x: mp2.anchorA.x - centerOffsetA.x, y: mp2.anchorA.y - centerOffsetA.y };
    mp2.anchorB = { x: mp2.anchorB.x - centerOffsetB.x, y: mp2.anchorB.y - centerOffsetB.y };

    mp2.normalImpulse = 0;
    mp2.tangentImpulse = 0;
    mp2.totalNormalImpulse = 0;
    mp2.normalVelocity = 0;
    mp2.persisted = false;

    const id2 = mp2.id;

    for (let j = 0; j < oldManifold.pointCount; j++) {
      const mp1 = oldManifold.points[j]!;
      if (mp1.id === id2) {
        mp2.normalImpulse = mp1.normalImpulse;
        mp2.tangentImpulse = mp1.tangentImpulse;
        mp2.persisted = true;

        // Clear old impulse.
        mp1.normalImpulse = 0;
        mp1.tangentImpulse = 0;
        break;
      }
    }
  }

  // Touching flag (contact.c:697-704).
  if (touching) {
    contactSim.simFlags |= SIM_TOUCHING_FLAG;
  } else {
    contactSim.simFlags &= ~SIM_TOUCHING_FLAG;
  }

  return touching;
}

// ─── addContactToGraph (overflow path of b2AddContactToGraph) ─────────────────

/**
 * Move a newly-touching contact's sim into the single overflow graph color.
 * Ports the overflow path of `b2AddContactToGraph` (constraint_graph.c:66-182).
 *
 * v1 has no graph coloring (box2d's `B2_FORCE_OVERFLOW` path), so `colorIndex`
 * is always {@link OVERFLOW_COLOR}. Pushes the SAME `contactSim` object
 * reference into `state.graphContactSims` (the move-the-reference porting
 * decision, mirroring `BodySim` relocation in solver_set.ts): box2d memcpys the
 * struct then the caller removes the source slot from the awake set's
 * `contactSims`, so re-using the live object reference is equivalent and avoids
 * a struct copy. Then refreshes the sim's transient body indices / inverse
 * masses from the current bodies (static side → {@link NULL_INDEX} / 0).
 */
export function addContactToGraph(
  state: PhysicsState,
  contactSim: ContactSim,
  contact: InternalContact
): void {
  // box2d asserts the contact is touching here (constraint_graph.c:68-70).
  if (contactSim.manifold.pointCount <= 0 || (contactSim.simFlags & SIM_TOUCHING_FLAG) === 0) {
    throw new Error("addContactToGraph: contact is not touching");
  }

  const colorIndex = OVERFLOW_COLOR;
  contact.colorIndex = colorIndex;
  contact.localIndex = state.graphContactSims.length;

  // Move-the-reference: push the live sim (see header). The caller removes it
  // from the source set's contactSims afterward.
  state.graphContactSims.push(contactSim);
  const newSim = contactSim;

  const awakeSet = state.solverSets[AWAKE_SET]!;

  // Refresh side A body index / inverse mass (constraint_graph.c:145-162).
  const bodyA = state.bodies.get(contact.edges[0].bodyId);
  if (bodyA.type === STATIC_BODY) {
    newSim.bodySimIndexA = NULL_INDEX;
    newSim.invMassA = 0;
    newSim.invIA = 0;
  } else {
    newSim.bodySimIndexA = bodyA.localIndex;
    const bodySimA = awakeSet.bodySims[bodyA.localIndex]!;
    newSim.invMassA = bodySimA.invMass;
    newSim.invIA = bodySimA.invInertia;
  }

  // Refresh side B body index / inverse mass (constraint_graph.c:164-181).
  const bodyB = state.bodies.get(contact.edges[1].bodyId);
  if (bodyB.type === STATIC_BODY) {
    newSim.bodySimIndexB = NULL_INDEX;
    newSim.invMassB = 0;
    newSim.invIB = 0;
  } else {
    newSim.bodySimIndexB = bodyB.localIndex;
    const bodySimB = awakeSet.bodySims[bodyB.localIndex]!;
    newSim.invMassB = bodySimB.invMass;
    newSim.invIB = bodySimB.invInertia;
  }
}

// ─── removeContactFromGraph (overflow path of b2RemoveContactFromGraph) ───────

/**
 * Swap-remove the contact sim at `localIndex` from the overflow graph color
 * (`state.graphContactSims`) and repair the moved sim's owning contact's
 * `localIndex`. Ports the overflow path of `b2RemoveContactFromGraph`
 * (constraint_graph.c:184-212) — the `colorIndex !== OVERFLOW_INDEX` bodySet
 * clears do not apply with no coloring. Reuses the {@link _removeContactSim}
 * swap-remove helper.
 */
export function removeContactFromGraph(state: PhysicsState, localIndex: number): void {
  _removeContactSim(state, state.graphContactSims, localIndex);
}
