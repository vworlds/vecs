// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
// Sleep transition: waking, sleeping, and sleeping-set merging (VP-23).
//
// Ports the three solver-set sleep helpers from box2d/src/solver_set.c:
//   - `b2WakeSolverSet`    (line 35)  — wake a sleeping island, restore body
//                                       states, move contacts back to the
//                                       constraint graph, transfer island.
//   - `b2TrySleepIsland`   (line 155) — put an awake island to sleep: allocate
//                                       a new sleeping solver set, move body
//                                       sims, mark move events fellAsleep, move
//                                       touching contacts out of the graph, move
//                                       the island record.
//   - `b2MergeSolverSets`  (line 417) — merge two sleeping sets into one (used
//                                       when a contact bridges two sleeping
//                                       islands). Joints dropped (no joints v1).
//
// Also exports `allocSleepingSet` / `freeSleepingSet` which manage the
// dynamically-growing `state.solverSets` array beyond index 2 (FIRST_SLEEPING_SET).
// These mirror box2d's `b2AllocId` / `b2FreeId` over `world->solverSetIdPool`.
//
// Circular-dependency note: `contact.ts` imports from `solver_set.ts`, so
// `solver_set.ts` cannot import from `contact.ts`. This file sits above both and
// imports from both freely (it is the only file that needs all three).
//
// Engine module boundary: imports only from math/, util/, and sibling engine/.

import { NULL_INDEX } from "../util/handle.js";
import { addContactToGraph, CONTACT_TOUCHING_FLAG, type ContactSim } from "./contact.js";
import { swapRemove } from "../util/dense_array.js";
import { AWAKE_SET, DISABLED_SET, FIRST_SLEEPING_SET, SolverSet } from "./solver_set.js";
import { makeIdentityBodyState } from "./body.js";
import type { PhysicsState } from "./state.js";

// ─── Sleeping-set allocation ──────────────────────────────────────────────────

/** Allocate a fresh sleeping-set slot, reusing a freed index from
 * `state.sleepingSetPool` when available, otherwise growing `state.solverSets`.
 * Mirrors `b2AllocId(&world->solverSetIdPool, …)` + the
 * `if (sleepSetId == world->solverSets.count) push_empty` pattern in
 * `b2TrySleepIsland` (solver_set.c:172-178). Returns the new set index. */
export function allocSleepingSet(state: PhysicsState): number {
  let setIndex: number;
  if (state.sleepingSetPool.length > 0) {
    setIndex = state.sleepingSetPool.pop()!;
    // Reuse the existing SolverSet object at this slot (cleared by freeSleepingSet).
    // The slot is guaranteed to exist and have all arrays empty.
  } else {
    // Grow the array: push a new SolverSet at the next index.
    setIndex = state.solverSets.length;
    state.solverSets.push(new SolverSet(setIndex));
  }
  return setIndex;
}

/** Release a sleeping-set slot back to the pool. The set must be empty before
 * calling. Mirrors `b2FreeId(&world->solverSetIdPool, setIndex)` +
 * `*set = (b2SolverSet){0}; set->setIndex = B2_NULL_INDEX` in
 * `b2DestroySolverSet` (solver_set.c:25-26). */
export function freeSleepingSet(state: PhysicsState, setIndex: number): void {
  const set = state.solverSets[setIndex];
  if (set === undefined || setIndex < FIRST_SLEEPING_SET) {
    return;
  }
  // Clear all arrays, but leave the SolverSet object in place for reuse.
  set.bodySims.length = 0;
  set.bodyStates.length = 0;
  set.contactSims.length = 0;
  set.islandSims.length = 0;
  // Return the index to the pool.
  state.sleepingSetPool.push(setIndex);
}

// ─── b2WakeSolverSet (solver_set.c:35) ───────────────────────────────────────

/**
 * Wake a sleeping solver set. Moves all body sims into the awake set, creates
 * fresh identity body states, moves non-touching contacts from the disabled set
 * to the awake set, moves touching contacts from the sleeping set's
 * `contactSims` back into the constraint graph, and transfers all island sims
 * to the awake set. Then destroys (frees) the sleeping set.
 *
 * Does NOT merge islands — each sleeping island is transferred independently.
 * Box2D comment: "Does not merge islands." (solver_set.c:29).
 *
 * Mirrors `b2WakeSolverSet` (solver_set.c:35-151).
 *
 * @param state   - live `PhysicsState`
 * @param setIndex - the sleeping-set index to wake (must be >= FIRST_SLEEPING_SET)
 */
export function wakeSolverSet(state: PhysicsState, setIndex: number): void {
  if (setIndex < FIRST_SLEEPING_SET) {
    throw new Error(`wakeSolverSet: setIndex ${setIndex} is not a sleeping set`);
  }
  const set = state.solverSets[setIndex]!;
  const awakeSet = state.solverSets[AWAKE_SET]!;
  const disabledSet = state.solverSets[DISABLED_SET]!;

  // ── Move body sims to the awake set (solver_set.c:44-101) ─────────────────
  // For each body in the sleeping set:
  //   1. Update body.setIndex and body.localIndex.
  //   2. Reset sleepTime to 0 (waking resets the counter).
  //   3. Append the sim to the awake set (move reference).
  //   4. Create an identity body state.
  //   5. Walk the body's contact list and move any non-touching contacts that
  //      are in the disabled set to the awake set's contactSims.
  const bodyCount = set.bodySims.length;
  for (let i = 0; i < bodyCount; i++) {
    const sim = set.bodySims[i]!;
    const body = state.bodies.get(sim.bodyId);
    // solver_set.c:51: body->setIndex = b2_awakeSet
    body.setIndex = AWAKE_SET;
    body.localIndex = awakeSet.bodySims.length;
    // solver_set.c:55: body->sleepTime = 0.0f
    body.sleepTime = 0;
    body.bodyMoveIndex = NULL_INDEX;

    awakeSet.bodySims.push(sim);

    // Identity body state (solver_set.c:60-63: state->flags = body->flags).
    const st = makeIdentityBodyState(sim.flags);
    awakeSet.bodyStates.push(st);

    // Move non-touching contacts from the disabled set to the awake set
    // (solver_set.c:65-100): walk headContactKey, skip contacts that are not
    // in the disabled set, move each disabled contact sim.
    let contactKey = body.headContactKey;
    while (contactKey !== NULL_INDEX) {
      const edgeIndex = contactKey & 1;
      const contactId = contactKey >> 1;
      const contact = state.contacts.get(contactId);
      contactKey = contact.edges[edgeIndex]!.nextKey;

      // Only handle contacts in the disabled set.
      if (contact.setIndex !== DISABLED_SET) {
        // solver_set.c:77: assert setIndex == awakeSet || setIndex == set
        continue;
      }

      const localIndex = contact.localIndex;
      const contactSim = disabledSet.contactSims[localIndex]!;

      // Assert: must be non-touching (solver_set.c:84-85).
      // (contactSim.manifold.pointCount should be 0)

      contact.setIndex = AWAKE_SET;
      contact.localIndex = awakeSet.contactSims.length;
      awakeSet.contactSims.push(contactSim);

      // Swap-remove from the disabled set, repairing the moved element.
      const movedSim = swapRemove(disabledSet.contactSims, localIndex);
      if (movedSim !== undefined) {
        state.contacts.get(movedSim.contactId).localIndex = localIndex;
      }
    }
  }

  // ── Move touching contacts from sleeping set to constraint graph ──────────
  // (solver_set.c:103-116): each contactSim in set.contactSims is touching;
  // call addContactToGraph which pushes to graphContactSims and sets colorIndex.
  {
    const count = set.contactSims.length;
    for (let i = 0; i < count; i++) {
      const contactSim = set.contactSims[i]!;
      const contact = state.contacts.get(contactSim.contactId);
      // solver_set.c:110-111: assert touching flag
      contact.setIndex = AWAKE_SET;
      // addContactToGraph sets contact.colorIndex and contact.localIndex
      addContactToGraph(state, contactSim, contact);
    }
  }

  // Joints: dropped (no joints in v1). solver_set.c:119-130 skipped.

  // ── Transfer island sims to the awake set (solver_set.c:132-147) ──────────
  {
    const count = set.islandSims.length;
    for (let i = 0; i < count; i++) {
      const islandSim = set.islandSims[i]!;
      const island = state.islands.get(islandSim.islandId);
      island.setIndex = AWAKE_SET;
      island.localIndex = awakeSet.islandSims.length;
      awakeSet.islandSims.push({ islandId: islandSim.islandId });
    }
  }

  // ── Destroy the sleeping set (solver_set.c:150) ───────────────────────────
  freeSleepingSet(state, setIndex);
}

// ─── b2TrySleepIsland (solver_set.c:155) ─────────────────────────────────────

/**
 * Attempt to put an awake island to sleep. Skips if the island has a pending
 * split (`constraintRemoveCount > 0` and more than one body). Otherwise:
 *   1. Allocates a new sleeping solver set.
 *   2. Moves body sims from the awake set to the sleeping set, destroying each
 *      body's body state, and moving non-touching contacts to the disabled set.
 *   3. Moves touching contacts from the constraint graph to the sleeping set's
 *      `contactSims` (removing them from `graphContactSims`).
 *   4. Moves the island record from the awake set's islandSims to the sleeping
 *      set's islandSims, updating the island's `setIndex`/`localIndex`.
 *
 * Joints: dropped (no joints in v1). Box2d solver_set.c:337-381 skipped.
 *
 * Mirrors `b2TrySleepIsland` (solver_set.c:155-411).
 */
export function trySleepIsland(state: PhysicsState, islandId: number): void {
  const island = state.islands.get(islandId);
  // solver_set.c:158: assert island->setIndex == b2_awakeSet
  if (island.setIndex !== AWAKE_SET) {
    return;
  }

  // solver_set.c:161-163: Cannot sleep while there is a pending split with > 1 body.
  if (island.constraintRemoveCount > 0 && island.bodies.length > 1) {
    return;
  }

  // ── Allocate a new sleeping solver set (solver_set.c:172-187) ─────────────
  const sleepSetId = allocSleepingSet(state);
  const sleepSet = state.solverSets[sleepSetId]!;

  // Grab awake set AFTER alloc (the solverSets array may have been resized).
  const awakeSet = state.solverSets[AWAKE_SET]!;
  const disabledSet = state.solverSets[DISABLED_SET]!;

  sleepSet.bodySims.length = 0;
  sleepSet.bodyStates.length = 0;
  sleepSet.contactSims.length = 0;
  sleepSet.islandSims.length = 0;

  // ── Move awake bodies to the sleeping set (solver_set.c:194-289) ──────────
  for (let i = 0; i < island.bodies.length; i++) {
    const bodyId = island.bodies[i]!;
    const body = state.bodies.get(bodyId);
    // solver_set.c:200-201: assert body->setIndex == awakeSet && islandId
    const awakeBodyIndex = body.localIndex;
    const awakeSim = awakeSet.bodySims[awakeBodyIndex]!;

    // solver_set.c:206-213: update fellAsleep on move event.
    if (body.bodyMoveIndex !== NULL_INDEX) {
      const moveEventBodyId = state.bodyMoveEvents[body.bodyMoveIndex];
      // Mark fellAsleep — VP-23 uses a Set<number> of bodyIds instead of
      // box2d's b2BodyMoveEvent array (bodyMoveEvents holds bodyIds, not events).
      // We store the fell-asleep set on state so the pose-sync-out can skip them.
      state.fellAsleepThisStep.add(moveEventBodyId!);
      body.bodyMoveIndex = NULL_INDEX;
    }

    // Move body sim to sleep set (solver_set.c:218-221).
    const sleepBodyIndex = sleepSet.bodySims.length;
    sleepSet.bodySims.push(awakeSim);

    // Swap-remove from the awake set (b2RemoveBodySim, solver_set.c:223).
    const movedSim = swapRemove(awakeSet.bodySims, awakeBodyIndex);
    if (movedSim !== undefined) {
      state.bodies.get(movedSim.bodyId).localIndex = awakeBodyIndex;
    }

    // Destroy state, no need to clone (solver_set.c:226).
    swapRemove(awakeSet.bodyStates, awakeBodyIndex);

    body.setIndex = sleepSetId;
    body.localIndex = sleepBodyIndex;

    // Move non-touching contacts to the disabled set (solver_set.c:232-288).
    // Non-touching contacts between sleeping bodies belong to neither island,
    // so they go to the disabled set.
    let contactKey = body.headContactKey;
    while (contactKey !== NULL_INDEX) {
      const contactId = contactKey >> 1;
      const edgeIndex = contactKey & 1;
      const contact = state.contacts.get(contactId);
      contactKey = contact.edges[edgeIndex]!.nextKey;

      // Only awake-set contacts (solver_set.c:241: assert setIndex == awake || disabled).
      if (contact.setIndex === DISABLED_SET) {
        // Already moved by another body in the island.
        continue;
      }

      // Touching contacts are moved separately (solver_set.c:250-255).
      if (contact.colorIndex !== NULL_INDEX) {
        // contact is touching and in the graph → moved in the contact loop below.
        continue;
      }

      // Check if the other body is still awake (solver_set.c:257-264).
      const otherEdgeIndex = edgeIndex ^ 1;
      const otherBodyId = contact.edges[otherEdgeIndex]!.bodyId;
      const otherBody = state.bodies.get(otherBodyId);
      if (otherBody.setIndex === AWAKE_SET) {
        // The other body is still awake; it is responsible for moving this
        // contact when it falls asleep.
        continue;
      }

      // Move non-touching contact to the disabled set (solver_set.c:267-287).
      const localIndex = contact.localIndex;
      const contactSim = awakeSet.contactSims[localIndex]!;

      contact.setIndex = DISABLED_SET;
      contact.localIndex = disabledSet.contactSims.length;
      disabledSet.contactSims.push(contactSim);

      const movedContactSim = swapRemove(awakeSet.contactSims, localIndex);
      if (movedContactSim !== undefined) {
        state.contacts.get(movedContactSim.contactId).localIndex = localIndex;
      }
    }
  }

  // ── Move touching contacts from graph to sleeping set (solver_set.c:293-335) ──
  for (let i = 0; i < island.contacts.length; i++) {
    const link = island.contacts[i]!;
    const contact = state.contacts.get(link.contactId);
    // solver_set.c:299-301: assert setIndex == awake && islandId
    const colorIndex = contact.colorIndex;
    // solver_set.c:302: assert 0 <= colorIndex < B2_GRAPH_COLOR_COUNT
    // In v1 all touching contacts are in the overflow color.

    // Get the sim from the graph (overflow color only).
    const localIndex = contact.localIndex;
    const awakeContactSim = state.graphContactSims[localIndex]!;

    const sleepContactIndex = sleepSet.contactSims.length;
    sleepSet.contactSims.push(awakeContactSim);

    // Swap-remove from graphContactSims (solver_set.c:321-329).
    const movedContactSim = swapRemove(state.graphContactSims, localIndex);
    if (movedContactSim !== undefined) {
      state.contacts.get(movedContactSim.contactId).localIndex = localIndex;
    }

    contact.setIndex = sleepSetId;
    contact.colorIndex = NULL_INDEX;
    contact.localIndex = sleepContactIndex;
  }

  // ── Move island struct to sleeping set (solver_set.c:383-404) ─────────────
  {
    const islandIndex = island.localIndex;

    // Push a new islandSim to the sleeping set.
    sleepSet.islandSims.push({ islandId });

    // Swap-remove the island from the awake set's islandSims.
    const movedIslandSim = swapRemove(awakeSet.islandSims, islandIndex);
    if (movedIslandSim !== undefined) {
      state.islands.get(movedIslandSim.islandId).localIndex = islandIndex;
    }

    island.setIndex = sleepSetId;
    island.localIndex = 0;
  }

  // solver_set.c:406-408: if world->splitIslandId == islandId reset it.
  if (state.splitIslandId === islandId) {
    state.splitIslandId = NULL_INDEX;
  }
}

// ─── b2MergeSolverSets (solver_set.c:417) ────────────────────────────────────

/**
 * Merge two sleeping solver sets into one, keeping the set with more bodies
 * (fewest to move). All body sims, contact sims, and island sims from the
 * smaller set migrate into the larger; the smaller set is destroyed (freed).
 *
 * Joints: dropped (no joints in v1). solver_set.c:473-487 skipped.
 *
 * Called by `b2LinkContact` when a contact bridges two sleeping islands. In
 * vecs-physics v1 this means both bodies were asleep and are now touching, so
 * we merge them into one sleeping island. The result is a single sleeping set
 * containing both islands (which will be merged when one of them wakes).
 *
 * Mirrors `b2MergeSolverSets` (solver_set.c:417-508).
 */
export function mergeSolverSets(state: PhysicsState, setId1: number, setId2: number): void {
  if (setId1 === setId2) {
    return;
  }

  let bigId = setId1;
  let smallId = setId2;
  let bigSet = state.solverSets[bigId]!;
  let smallSet = state.solverSets[smallId]!;

  // Move the fewest bodies (solver_set.c:425-434: swap if set1 has fewer bodies).
  if (bigSet.bodySims.length < smallSet.bodySims.length) {
    const tmp = bigSet;
    bigSet = smallSet;
    smallSet = tmp;
    const tmpId = bigId;
    bigId = smallId;
    smallId = tmpId;
  }

  // Transfer bodies (solver_set.c:437-452).
  {
    const bodyCount = smallSet.bodySims.length;
    for (let i = 0; i < bodyCount; i++) {
      const sim = smallSet.bodySims[i]!;
      const body = state.bodies.get(sim.bodyId);
      body.setIndex = bigId;
      body.localIndex = bigSet.bodySims.length;
      bigSet.bodySims.push(sim);
    }
  }

  // Transfer contacts (solver_set.c:455-469).
  {
    const contactCount = smallSet.contactSims.length;
    for (let i = 0; i < contactCount; i++) {
      const contactSim = smallSet.contactSims[i]!;
      const contact = state.contacts.get(contactSim.contactId);
      contact.setIndex = bigId;
      contact.localIndex = bigSet.contactSims.length;
      bigSet.contactSims.push(contactSim);
    }
  }

  // Transfer islands (solver_set.c:489-503).
  {
    const islandCount = smallSet.islandSims.length;
    for (let i = 0; i < islandCount; i++) {
      const islandSim = smallSet.islandSims[i]!;
      const island = state.islands.get(islandSim.islandId);
      island.setIndex = bigId;
      island.localIndex = bigSet.islandSims.length;
      bigSet.islandSims.push({ islandId: islandSim.islandId });
    }
  }

  // Destroy the merged set (solver_set.c:506).
  freeSleepingSet(state, smallId);
}

// ─── installSleepHooks ────────────────────────────────────────────────────────

/**
 * Wire `wakeSolverSet` and `mergeSolverSets` into `state`'s callback hooks so
 * `island.ts`'s `linkContact` can call them without a circular import. Called
 * once at the start of the first `engineStep` (or on install). Safe to call
 * multiple times. */
export function installSleepHooks(state: PhysicsState): void {
  state._wakeSolverSet = wakeSolverSet;
  state._mergeSolverSets = mergeSolverSets;
}

// ─── b2WakeBody (body.c:328) ──────────────────────────────────────────────────

/**
 * Wake the body keyed by `bodyId` if it is in a sleeping set. Returns `true`
 * when the body was sleeping and has been woken. Returns `false` when the body
 * is already awake (or disabled / static). Mirrors `b2WakeBody` (body.c:328):
 *   if ( body->setIndex >= b2_firstSleepingSet )
 *     b2WakeSolverSet( world, body->setIndex );
 *     return true;
 *   return false;
 */
export function wakeBody(state: PhysicsState, bodyId: number): boolean {
  const body = state.bodies.get(bodyId);
  if (body.setIndex >= FIRST_SLEEPING_SET) {
    wakeSolverSet(state, body.setIndex);
    return true;
  }
  return false;
}
