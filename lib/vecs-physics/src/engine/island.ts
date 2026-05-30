// Island graph: build / merge / link / unlink (VP-16).
//
// Ports box2d/src/island.{h,c} and the body-island hooks from box2d/src/body.c.
// An island is a connected component of the contact/joint graph over awake
// non-static bodies (https://en.wikipedia.org/wiki/Component_(graph_theory)).
// Static bodies are never in an island; a contact may connect to a static body
// but the static side carries no island id.
//
// MILESTONE-3 scope (see PROGRESS.md → MILESTONE 3):
//   - Islands are BUILT here but NOT consumed by the solver in M3 (box2d's
//     overflow solver iterates the contact array directly). They exist to keep
//     the touch-begin/end flow faithful (link/unlink) and seat the structure
//     sleep needs in M5.
//   - **Island SPLIT is deferred to M5.** `unlinkContact` only increments
//     `constraintRemoveCount`; `b2SplitIsland`/`b2SplitIslandTask` are NOT
//     ported. The `splitIslandId` world reset in `b2DestroyIsland` is likewise
//     skipped (no split bookkeeping in M3).
//   - **No sleep in M3.** `b2LinkContact`'s wake-sleeping-set logic is skipped
//     (no sleeping sets exist yet); see the comment in `linkContact`.
//   - **No joints in v1.** box2d's `b2Island.joints` / `b2JointLink` and the
//     joint migration in `b2MergeIslands` are dropped.
//
// Engine module boundary: imports only from util/ and sibling engine/.

import { swapRemove } from "../util/dense_array.js";
import { NULL_INDEX, type Handle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";

import type { InternalBody } from "./body.js";
import type { InternalContact } from "./contact.js";
import { AWAKE_SET } from "./solver_set.js";
import type { PhysicsState } from "./state.js";

// ─── ContactLink ──────────────────────────────────────────────────────────────

/** Cached contact data stored in an island for fast contiguous iteration.
 * Mirrors `b2ContactLink` (island.h:17). The two body ids are cached so a future
 * `b2SplitIsland` union-find pass (M5) never needs to touch the
 * {@link InternalContact} records. */
export interface ContactLink {
  contactId: number;
  bodyIdA: number;
  bodyIdB: number;
}

// ─── InternalIsland ───────────────────────────────────────────────────────────

/** Persistent island for awake bodies and their touching contacts. Mirrors
 * `b2Island` (island.h:49) minus the `joints` array (no joints in v1). */
export interface InternalIsland {
  /** Index of the solver set this island lives in (or {@link NULL_INDEX}).
   * Mirrors `b2Island.setIndex`. In M3 this is always {@link AWAKE_SET}. */
  setIndex: number;
  /** Island index within its set's `islandSims` (or {@link NULL_INDEX}).
   * Mirrors `b2Island.localIndex`. */
  localIndex: number;
  /** This island's own handle index. Mirrors `b2Island.islandId`. */
  islandId: number;
  /** How many contacts have been removed from this island. Drives the
   * split-candidate test (M5). Mirrors `b2Island.constraintRemoveCount`. */
  constraintRemoveCount: number;
  /** Body handle indices in this island. Mirrors `b2Island.bodies`. */
  bodies: number[];
  /** Touching contacts that belong to this island (may connect to static
   * bodies not in the island). Mirrors `b2Island.contacts`. */
  contacts: ContactLink[];
}

// ─── IslandStorage ────────────────────────────────────────────────────────────

/** Owns the sparse {@link InternalIsland} table and the index allocator that
 * hands out island ids. Mirrors {@link BodyStorage} / {@link ContactStorage}. */
export class IslandStorage {
  /** Sparse, indexed by an island id; `undefined` for a freed slot. */
  public readonly records: (InternalIsland | undefined)[] = [];

  /** Allocates island ids, stamping each with a generation. Plain numeric pool,
   * matching how `ContactStorage` uses a generic {@link IdPool}. */
  public readonly idPool = new IdPool<Handle>();

  /** Live island at an id. Throws if the slot is empty. */
  public get(index: number): InternalIsland {
    const island = this.records[index];
    if (island === undefined) {
      throw new Error(`no island at index ${index}`);
    }
    return island;
  }
}

// ─── createIsland (b2CreateIsland, island.c:15) ──────────────────────────────

/** Allocate an empty island in `setIndex`, registering an `islandSim` in that
 * set. Mirrors `b2CreateIsland` (island.c:15). For M3, `setIndex` is always
 * {@link AWAKE_SET}. */
export function createIsland(state: PhysicsState, setIndex: number): InternalIsland {
  const handle = state.islands.idPool.allocate();
  const islandId = handle.index;

  const set = state.solverSets[setIndex]!;

  const island: InternalIsland = {
    setIndex,
    localIndex: set.islandSims.length,
    islandId,
    constraintRemoveCount: 0,
    bodies: [],
    contacts: [],
  };
  state.islands.records[islandId] = island;

  set.islandSims.push({ islandId });

  return island;
}

// ─── destroyIsland (b2DestroyIsland, island.c:48) ────────────────────────────

/** Free an empty island, swap-removing its `islandSim` from its set (and fixing
 * the moved island's `localIndex`) and freeing the record + id. Mirrors
 * `b2DestroyIsland` (island.c:48). The `splitIslandId` world reset is skipped
 * (no split in M3). */
export function destroyIsland(state: PhysicsState, islandId: number): void {
  // assume island is empty
  const island = state.islands.get(islandId);
  const set = state.solverSets[island.setIndex]!;

  const localIndex = island.localIndex;
  const moved = swapRemove(set.islandSims, localIndex);
  if (moved !== undefined) {
    state.islands.get(moved.islandId).localIndex = localIndex;
  }

  // Free island and id.
  island.constraintRemoveCount = 0;
  island.localIndex = NULL_INDEX;
  island.islandId = NULL_INDEX;
  island.setIndex = NULL_INDEX;
  state.islands.records[islandId] = undefined;
  state.islands.idPool.free(islandId);
}

// ─── mergeIslands (b2MergeIslands, island.c:82) ──────────────────────────────

/** Merge islands `islandIdA` and `islandIdB`, keeping the bigger one (by body
 * count) and destroying the smaller. The smaller island's bodies and contact
 * links migrate into the bigger (fixing each body's / contact's
 * `islandId`/`islandIndex`), and the removed-constraint count carries over.
 * Returns the surviving island id. Mirrors `b2MergeIslands` (island.c:82). The
 * joint migration is dropped (no joints in v1). */
export function mergeIslands(state: PhysicsState, islandIdA: number, islandIdB: number): number {
  if (islandIdA === islandIdB) {
    return islandIdA;
  }

  if (islandIdA === NULL_INDEX) {
    return islandIdB;
  }

  if (islandIdB === NULL_INDEX) {
    return islandIdA;
  }

  const islandA = state.islands.get(islandIdA);
  const islandB = state.islands.get(islandIdB);

  // Keep the biggest island to reduce cache misses.
  let bigIsland: InternalIsland;
  let smallIsland: InternalIsland;
  if (islandA.bodies.length >= islandB.bodies.length) {
    bigIsland = islandA;
    smallIsland = islandB;
  } else {
    bigIsland = islandB;
    smallIsland = islandA;
  }

  const bigIslandId = bigIsland.islandId;

  // Move bodies from the smaller island to the larger island.
  for (const bodyId of smallIsland.bodies) {
    const body = state.bodies.get(bodyId);
    body.islandId = bigIslandId;
    body.islandIndex = bigIsland.bodies.length;
    bigIsland.bodies.push(bodyId);
  }

  // Migrate contacts from the smaller island to the larger island.
  for (const link of smallIsland.contacts) {
    const contact = state.contacts.get(link.contactId);
    contact.islandId = bigIslandId;
    contact.islandIndex = bigIsland.contacts.length;
    bigIsland.contacts.push(link);
  }

  // Track removed constraints.
  bigIsland.constraintRemoveCount += smallIsland.constraintRemoveCount;

  destroyIsland(state, smallIsland.islandId);

  return bigIslandId;
}

// ─── addContactToIsland (b2AddContactToIsland, island.c:174) ──────────────────

/** Record `contact` in island `islandId`: set the contact's island
 * id/index and push a {@link ContactLink} caching its two body ids. Mirrors
 * `b2AddContactToIsland` (island.c:174). */
export function addContactToIsland(
  state: PhysicsState,
  islandId: number,
  contact: InternalContact
): void {
  const island = state.islands.get(islandId);

  contact.islandId = islandId;
  contact.islandIndex = island.contacts.length;

  island.contacts.push({
    contactId: contact.contactId,
    bodyIdA: contact.edges[0].bodyId,
    bodyIdB: contact.edges[1].bodyId,
  });
}

// ─── linkContact (b2LinkContact, island.c:194) ───────────────────────────────

/** Link a touching `contact` into the island graph, merging the two bodies'
 * islands (one is destroyed) and adding the contact to the survivor. Mirrors
 * `b2LinkContact` (island.c:194). At least one body is dynamic, so at least one
 * has an island. The wake-sleeping-set logic (island.c:207-217) is skipped: no
 * sleep / sleeping sets in M3. */
export function linkContact(state: PhysicsState, contact: InternalContact): void {
  const bodyIdA = contact.edges[0].bodyId;
  const bodyIdB = contact.edges[1].bodyId;

  const bodyA = state.bodies.get(bodyIdA);
  const bodyB = state.bodies.get(bodyIdB);

  // box2d wakes a sleeping body here if its partner is awake. No sleeping sets
  // exist in M3, so there is nothing to wake.

  const islandIdA = bodyA.islandId;
  const islandIdB = bodyB.islandId;

  // Merge islands. This will destroy one of the islands.
  const finalIslandId = mergeIslands(state, islandIdA, islandIdB);

  // Add the contact to the island that survived.
  addContactToIsland(state, finalIslandId, contact);
}

// ─── unlinkContact (b2UnlinkContact, island.c:235) ───────────────────────────

/** Unlink `contact` from its island when it stops touching (or is destroyed):
 * swap-remove its link (fixing the moved link's contact `islandIndex`), clear
 * the contact's island id/index, and bump the island's `constraintRemoveCount`.
 * Mirrors `b2UnlinkContact` (island.c:235). **No split** — `b2SplitIsland` is
 * deferred to M5. */
export function unlinkContact(state: PhysicsState, contact: InternalContact): void {
  const islandId = contact.islandId;
  const island = state.islands.get(islandId);

  const removeIndex = contact.islandIndex;
  const moved = swapRemove(island.contacts, removeIndex);
  if (moved !== undefined) {
    // Fix islandIndex on the contact that was swapped into removeIndex.
    state.contacts.get(moved.contactId).islandIndex = removeIndex;
  }

  contact.islandId = NULL_INDEX;
  contact.islandIndex = NULL_INDEX;
  island.constraintRemoveCount += 1;

  // box2d marks the island for splitting here (constraintRemoveCount > 0).
  // Split is deferred to M5.
}

// ─── createIslandForBody (b2CreateIslandForBody, body.c:106) ──────────────────

/** Create a fresh singleton island holding just `body`, for an enabled (awake)
 * dynamic/kinematic body. Mirrors `b2CreateIslandForBody` (body.c:106). */
export function createIslandForBody(
  state: PhysicsState,
  setIndex: number,
  body: InternalBody
): void {
  const island = createIsland(state, setIndex);
  // box2d pushes `body->id` (the body handle index). We recover it from the
  // body's sim back-pointer (`BodySim.bodyId`), addressed by the body's
  // `localIndex` within its set.
  const bodyId = state.solverSets[body.setIndex]!.bodySims[body.localIndex]!.bodyId;
  island.bodies.push(bodyId);
  body.islandId = island.islandId;
  body.islandIndex = 0;
}

// ─── removeBodyFromIsland (b2RemoveBodyFromIsland, body.c:119) ─────────────────

/** Remove `body` from its island, swap-removing it from the island's body list
 * (fixing the moved body's `islandIndex`). If the island is now empty it is
 * destroyed. Clears the body's island id/index. Mirrors
 * `b2RemoveBodyFromIsland` (body.c:119). The caller must have already torn down
 * the body's contacts so the island is a singleton when this empties it (the
 * empty-island assert below mirrors box2d). */
export function removeBodyFromIsland(state: PhysicsState, body: InternalBody): void {
  if (body.islandId === NULL_INDEX) {
    return;
  }

  const islandId = body.islandId;
  const island = state.islands.get(islandId);

  const localIndex = body.islandIndex;
  const moved = swapRemove(island.bodies, localIndex);
  if (moved !== undefined) {
    state.bodies.get(moved).islandIndex = localIndex;
  }

  if (island.bodies.length === 0) {
    // Destroy empty island. box2d asserts no contacts/joints remain.
    if (island.contacts.length !== 0) {
      throw new Error("removeBodyFromIsland: emptied island still has contacts");
    }
    destroyIsland(state, island.islandId);
  }

  body.islandId = NULL_INDEX;
  body.islandIndex = NULL_INDEX;
}
