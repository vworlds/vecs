// Solver sets and the body create / destroy / transfer operations that move
// bodies between them. Ports `b2SolverSet` and `b2TransferBody` from
// box2d/src/solver_set.c, scoped to bodies — contacts, joints, islands, and
// sleeping-set allocation arrive with the tickets that build them.
//
// The Box2D C code `memcpy`s a `b2BodySim` struct into the target set's array
// then removes it from the source. We instead **move the object reference**: a
// `BodySim` relocates between solver-set arrays without copying. Indices still
// need fixing exactly as Box2D does — a swap-pop in the source array moves the
// last element into the vacated slot, and that element's `localIndex` must be
// repaired. See PLAN.md → _Box2D Porting Strategy_ (port the model, not the C
// representation) and _Solver sets_.

import { swapRemove } from "../util/dense_array.js";
import type { BodyHandle } from "../util/handle.js";
import {
  BodyStorage,
  makeBodySim,
  makeIdentityBodyState,
  type BodySim,
  type BodyState,
  type InternalBody,
} from "./body.js";

// Solver-set indices, mirroring `b2SolverSetType`. The static, disabled, and
// awake sets are fixed; sleeping islands take indices from `FIRST_SLEEPING_SET`
// up (allocated when sleep lands).
export const STATIC_SET = 0;
export const DISABLED_SET = 1;
export const AWAKE_SET = 2;
export const FIRST_SLEEPING_SET = 3;

/** A solver set: the dense body sims (and, for the awake set, body states) that
 * live together for memory locality. Mirrors `b2SolverSet`, bodies only —
 * contact/joint/island arrays are added by their tickets. */
export class SolverSet {
  /** This set's index (one of the constants above, or a sleeping-set id). */
  public readonly setIndex: number;

  /** Dense body simulation data. */
  public readonly bodySims: BodySim[] = [];

  /** Dense solver state, parallel to {@link bodySims}. Populated only for the
   * awake set; empty for static, disabled, and sleeping sets. */
  public readonly bodyStates: BodyState[] = [];

  public constructor(setIndex: number) {
    this.setIndex = setIndex;
  }
}

/** The three always-present solver sets, indexed by the set-type constants. */
export function createBaseSolverSets(): SolverSet[] {
  const sets: SolverSet[] = [];
  sets[STATIC_SET] = new SolverSet(STATIC_SET);
  sets[DISABLED_SET] = new SolverSet(DISABLED_SET);
  sets[AWAKE_SET] = new SolverSet(AWAKE_SET);
  return sets;
}

/** Create a body record and its sim in `set`, allocating a handle. A body in the
 * awake set also gets a {@link BodyState}. Mirrors the storage half of
 * `b2CreateBody`; reading components into the sim is a later ticket. */
export function createBody(storage: BodyStorage, set: SolverSet): BodyHandle {
  const handle = storage.idPool.allocate();
  const sim = makeBodySim(handle.index);
  const body: InternalBody = { setIndex: set.setIndex, localIndex: set.bodySims.length };
  storage.records[handle.index] = body;
  set.bodySims.push(sim);
  if (set.setIndex === AWAKE_SET) {
    set.bodyStates.push(makeIdentityBodyState(sim.flags));
  }
  return handle;
}

/** Remove a body and its sim from `set` and free its handle. Mirrors the storage
 * half of `b2DestroyBody`. */
export function destroyBody(storage: BodyStorage, set: SolverSet, handle: BodyHandle): void {
  const body = storage.get(handle.index);
  const localIndex = body.localIndex;
  removeBodySim(set, localIndex, storage);
  if (set.setIndex === AWAKE_SET) {
    swapRemove(set.bodyStates, localIndex);
  }
  storage.records[handle.index] = undefined;
  storage.idPool.free(handle);
}

/** Move `body` from `sourceSet` to `targetSet`, relocating its sim (and its
 * state when crossing the awake-set boundary) while keeping every set's
 * `localIndex` back-pointers correct. Mirrors `b2TransferBody`. No-op when the
 * two sets are the same. */
export function transferBody(
  storage: BodyStorage,
  targetSet: SolverSet,
  sourceSet: SolverSet,
  body: InternalBody
): void {
  if (targetSet === sourceSet) {
    return;
  }

  const sourceIndex = body.localIndex;
  const sim = sourceSet.bodySims[sourceIndex]!;

  // Append to the target (move the reference, no copy) before removing from the
  // source, matching Box2D's order.
  const targetIndex = targetSet.bodySims.length;
  targetSet.bodySims.push(sim);

  // Box2D clears the transient sim flags (isFast | isSpeedCapped |
  // hadTimeOfImpact) here. Those are set by the solver/CCD, which are not ported
  // yet, so there is nothing to clear in VP-5.

  removeBodySim(sourceSet, sourceIndex, storage);

  // Body state exists only in the awake set: drop it when leaving, create a
  // fresh identity state when entering.
  if (sourceSet.setIndex === AWAKE_SET) {
    swapRemove(sourceSet.bodyStates, sourceIndex);
  } else if (targetSet.setIndex === AWAKE_SET) {
    targetSet.bodyStates.push(makeIdentityBodyState(sim.flags));
  }

  body.setIndex = targetSet.setIndex;
  body.localIndex = targetIndex;
}

/** Swap-pop the sim at `localIndex` out of `set` and repair the moved sim's
 * owner `localIndex`. Mirrors `b2RemoveBodySim`. */
function removeBodySim(set: SolverSet, localIndex: number, storage: BodyStorage): void {
  const moved = swapRemove(set.bodySims, localIndex);
  if (moved !== undefined) {
    storage.get(moved.bodyId).localIndex = localIndex;
  }
}
