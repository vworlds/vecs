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
import { AWAKE_SET, FIRST_SLEEPING_SET as _FIRST_SLEEPING_SET } from "./solver_set.js";
import type { PhysicsState } from "./state.js";

// ─── Union-find helpers (inline, for b2SplitIsland) ─────────────────────────
//
// Mirrors the static inline helpers `b2IslandFindParent` (island.c:344) and
// `b2IslandUnion` (island.c:359) used by `b2SplitIsland`.

/** Path-compressing find on a `parents` index array.
 * Mirrors `b2IslandFindParent` (island.c:344-355). */
function _islandFindParent(parents: number[], node: number): number {
  while (parents[node] !== node) {
    const grandParent = parents[parents[node]!]!;
    parents[node] = grandParent;
    node = grandParent;
  }
  return node;
}

/** Union by rank: connect the components containing node1 and node2, merging
 * their contact counts. Mirrors `b2IslandUnion` (island.c:359-385). */
function _islandUnion(
  parents: number[],
  ranks: number[],
  contactCounts: number[],
  node1: number,
  node2: number
): void {
  const root1 = _islandFindParent(parents, node1);
  const root2 = _islandFindParent(parents, node2);
  if (root1 === root2) {
    return;
  }
  if (ranks[root1]! < ranks[root2]!) {
    parents[root1] = root2;
    contactCounts[root2]! += contactCounts[root1]!;
  } else if (ranks[root1]! > ranks[root2]!) {
    parents[root2] = root1;
    contactCounts[root1]! += contactCounts[root2]!;
  } else {
    parents[root2] = root1;
    ranks[root1]!++;
    contactCounts[root1]! += contactCounts[root2]!;
  }
}

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
 * `b2DestroyIsland` (island.c:48). The `splitIslandId` world reset (island.c:50)
 * is now wired for M5 sleep. */
export function destroyIsland(state: PhysicsState, islandId: number): void {
  // b2DestroyIsland (island.c:50-52): reset splitIslandId if this island was the candidate.
  if (state.splitIslandId === islandId) {
    state.splitIslandId = NULL_INDEX;
  }

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
 * `b2LinkContact` (island.c:194).
 *
 * At least one body is dynamic, so at least one has an island. When one body is
 * awake and the other is sleeping, the sleeping body's set is woken via
 * `wakeSolverSet` (island.c:207-217). When both bodies are in sleeping sets, the
 * two sets are merged via `mergeSolverSets` (island.c:212-217). */
export function linkContact(state: PhysicsState, contact: InternalContact): void {
  const bodyIdA = contact.edges[0]!.bodyId;
  const bodyIdB = contact.edges[1]!.bodyId;

  const bodyA = state.bodies.get(bodyIdA);
  const bodyB = state.bodies.get(bodyIdB);

  // island.c:207-217: wake sleeping bodies when a contact begins.
  // Import lazily to avoid circular dependency (sleep.ts imports island.ts).
  // We use dynamic access on `state` which already has the right type.
  const setA = bodyA.setIndex;
  const setB = bodyB.setIndex;

  if (setA >= _FIRST_SLEEPING_SET || setB >= _FIRST_SLEEPING_SET) {
    // Lazy import avoidance: import sleep functions via a module-level re-export
    // in state.ts is not possible without circularity. Instead we call the
    // functions from the cached module reference stored on state.
    // island.c:207-210: if setA is sleeping and setB is awake → wake A.
    // island.c:211-213: if setB is sleeping and setA is awake → wake B.
    // island.c:214-217: if both sleeping → merge the two sets.
    if (setA >= _FIRST_SLEEPING_SET && setB >= _FIRST_SLEEPING_SET) {
      // Both sleeping: merge their sets so they stay asleep together.
      state._mergeSolverSets(state, setA, setB);
      // After merge, both bodies are in the same set. Re-read.
    } else if (setA >= _FIRST_SLEEPING_SET) {
      // A is sleeping, B is awake → wake A.
      state._wakeSolverSet(state, setA);
    } else {
      // B is sleeping, A is awake → wake B.
      state._wakeSolverSet(state, setB);
    }
  }

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

// ─── splitIsland (b2SplitIsland, island.c:389) ──────────────────────────────
//
// Union-find DFS over the base island's contact graph. Allocates per-component
// arrays, creates new islands, reassigns bodies and contacts. The base island is
// destroyed after the split.
//
// **Joints dropped**: no joints in v1. The `jointCounts` and joint-union loops
// in box2d (island.c:459-484, 613-631) are omitted; we pass a dummy zero array
// for `contactCounts` since contacts are the only edges.
//
// Mirrors `b2SplitIsland` (island.c:389-650) + `b2SplitIslandTask` (island.c:659).

/** Split island `baseId` into its connected components. Called when
 * `constraintRemoveCount > 0` and an island needs splitting before sleeping.
 * Creates one new island per component; the base island is destroyed.
 * Mirrors `b2SplitIsland` (island.c:389-650). No-op if the island is already
 * a single connected component (resets `constraintRemoveCount` to 0 instead). */
export function splitIsland(state: PhysicsState, baseId: number): void {
  const baseIsland = state.islands.get(baseId);
  // island.c:392-393: assert constraintRemoveCount > 0 && setIndex == awakeSet
  if (baseIsland.constraintRemoveCount <= 0 || baseIsland.setIndex !== AWAKE_SET) {
    return;
  }

  // Cache base island data before createIsland may reallocate (island.c:399-409).
  const baseBodyCount = baseIsland.bodies.length;
  const baseBodyIds = baseIsland.bodies.slice(); // snapshot
  const baseContacts = baseIsland.contacts.slice(); // snapshot

  // island.c:415-425: allocate union-find arrays.
  const parents: number[] = new Array(baseBodyCount);
  const contactCounts: number[] = new Array(baseBodyCount).fill(0);
  const ranks: number[] = new Array(baseBodyCount).fill(0);
  for (let i = 0; i < baseBodyCount; i++) {
    parents[i] = i;
  }

  // island.c:430-455: union over contacts.
  for (let i = 0; i < baseContacts.length; i++) {
    const link = baseContacts[i]!;
    const bodyA = state.bodies.get(link.bodyIdA);
    const bodyB = state.bodies.get(link.bodyIdB);
    const islandIndexA = bodyA.islandIndex;
    const islandIndexB = bodyB.islandIndex;

    // Only connect non-static bodies.
    if (islandIndexA !== NULL_INDEX && islandIndexB !== NULL_INDEX) {
      _islandUnion(parents, ranks, contactCounts, islandIndexA, islandIndexB);
      const root = _islandFindParent(parents, islandIndexA);
      contactCounts[root]!++;
    } else {
      const islandIndex = islandIndexA !== NULL_INDEX ? islandIndexA : islandIndexB;
      if (islandIndex !== NULL_INDEX) {
        const root = _islandFindParent(parents, islandIndex);
        contactCounts[root]!++;
      }
    }
  }

  // Joints: dropped (no joints in v1). island.c:459-484 skipped.

  // island.c:491-499: flatten parents and count components.
  let componentCount = 0;
  for (let i = 0; i < baseBodyCount; i++) {
    parents[i] = _islandFindParent(parents, i);
    if (parents[i] === i) {
      componentCount++;
    }
  }

  // island.c:502-509: early return when still fully connected.
  if (componentCount === 1) {
    baseIsland.constraintRemoveCount = 0;
    return;
  }

  // island.c:512-526: detach body/contact arrays from base island so destroyIsland
  // won't destroy them. We already snapshotted them above; clear the island's arrays.
  baseIsland.bodies.length = 0;
  baseIsland.contacts.length = 0;

  // island.c:529-572: create new islands, one per component, reserving arrays.
  // Map from (island body-index root → component index).
  const rootMap = new Array<number>(baseBodyCount).fill(NULL_INDEX);
  const componentBodyCounts = new Array<number>(componentCount).fill(0);
  const componentContactCounts = new Array<number>(componentCount).fill(0);
  let islandCount = 0;
  for (let i = 0; i < baseBodyCount; i++) {
    const rootIndex = parents[i]!;
    if (rootMap[rootIndex] === NULL_INDEX) {
      rootMap[rootIndex] = islandCount;
      componentBodyCounts[islandCount] = 0;
      componentContactCounts[islandCount] = contactCounts[rootIndex]!;
      islandCount++;
    }
    componentBodyCounts[rootMap[rootIndex]!]!++;
  }

  // island.c:560-572: create new islands.
  const islandIds = new Array<number>(islandCount);
  for (let i = 0; i < islandCount; i++) {
    const newIsland = createIsland(state, AWAKE_SET);
    islandIds[i] = newIsland.islandId;
    // Pre-fill with dummy slots (island.c reserves capacity).
    newIsland.bodies.length = 0;
    newIsland.contacts.length = 0;
  }

  // island.c:575-590: assign bodies to new islands.
  for (let i = 0; i < baseBodyCount; i++) {
    const bodyId = baseBodyIds[i]!;
    const root = _islandFindParent(parents, i);
    const newIslandId = islandIds[rootMap[root]!]!;
    const body = state.bodies.get(bodyId);
    const newIsland = state.islands.get(newIslandId);

    body.islandId = newIslandId;
    body.islandIndex = newIsland.bodies.length;
    newIsland.bodies.push(bodyId);
  }

  // island.c:593-610: assign contacts to the island of their bodies.
  for (let i = 0; i < baseContacts.length; i++) {
    const link = baseContacts[i]!;
    const contact = state.contacts.get(link.contactId);

    // Static bodies don't have an island id. Use either body's island.
    const bodyA = state.bodies.get(link.bodyIdA);
    const bodyB = state.bodies.get(link.bodyIdB);
    const targetIslandId = bodyA.islandId !== NULL_INDEX ? bodyA.islandId : bodyB.islandId;

    const targetIsland = state.islands.get(targetIslandId);
    contact.islandId = targetIslandId;
    contact.islandIndex = targetIsland.contacts.length;
    targetIsland.contacts.push(link);
  }

  // Joints: dropped (no joints in v1). island.c:613-631 skipped.

  // island.c:633: destroy the base island.
  destroyIsland(state, baseId);
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
