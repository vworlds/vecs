// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.

import type { Entity } from "@vworlds/vecs";

import { swapRemove } from "../util/dense_array.js";
import { NULL_INDEX, type BodyHandle } from "../util/handle.js";
import {
  BODY_TRANSIENT_FLAGS,
  BodyStorage,
  DYNAMIC_BODY,
  DYNAMIC_FLAG,
  STATIC_BODY,
  makeBodySim,
  makeIdentityBodyState,
  type BodySim,
  type BodyState,
  type InternalBody,
} from "./body.js";
import type { ContactSim } from "./contact.js";
import { createIslandForBody, removeBodyFromIsland } from "./island.js";
import type { PhysicsState } from "./state.js";

export const STATIC_SET = 0;
export const DISABLED_SET = 1;
export const AWAKE_SET = 2;
export const FIRST_SLEEPING_SET = 3;

export class SolverSet {
  public readonly bodySims: BodySim[] = [];
  public readonly bodyStates: BodyState[] = [];
  public readonly contactSims: ContactSim[] = [];
  public readonly islandSims: { islandId: number }[] = [];

  public constructor(public readonly setIndex: number) {}
}

export function createBaseSolverSets(): SolverSet[] {
  const sets: SolverSet[] = [];
  sets[STATIC_SET] = new SolverSet(STATIC_SET);
  sets[DISABLED_SET] = new SolverSet(DISABLED_SET);
  sets[AWAKE_SET] = new SolverSet(AWAKE_SET);
  return sets;
}

export function createBody(
  state: PhysicsState,
  set: SolverSet,
  entity: Entity,
  type: number
): BodyHandle {
  const storage = state.bodies;
  const handle = storage.idPool.allocate();
  const sim = makeBodySim(handle.index);
  if (type === DYNAMIC_BODY) {
    sim.flags |= DYNAMIC_FLAG;
  }
  const body: InternalBody = {
    entity,
    type,
    setIndex: set.setIndex,
    localIndex: set.bodySims.length,
    shapeHead: NULL_INDEX,
    shapeCount: 0,
    massDirty: false,
    headContactKey: NULL_INDEX,
    contactCount: 0,
    islandId: NULL_INDEX,
    islandIndex: NULL_INDEX,
    sleepTime: 0,
    sleepThreshold: 0.05,
    flags: 0,
    bodyMoveIndex: NULL_INDEX,
  };
  storage.records[handle.index] = body;
  set.bodySims.push(sim);
  if (set.setIndex === AWAKE_SET) {
    set.bodyStates.push(makeIdentityBodyState(sim.flags));
  }
  if (set.setIndex === AWAKE_SET && type !== STATIC_BODY) {
    createIslandForBody(state, AWAKE_SET, body);
  }
  return handle;
}

export function destroyBody(state: PhysicsState, set: SolverSet, handle: BodyHandle): void {
  const storage = state.bodies;
  const body = storage.get(handle.index);

  removeBodyFromIsland(state, body);

  const localIndex = body.localIndex;
  removeBodySim(set, localIndex, storage);
  if (set.setIndex === AWAKE_SET) {
    swapRemove(set.bodyStates, localIndex);
  }
  storage.records[handle.index] = undefined;
  storage.idPool.free(handle);
}

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
  const targetIndex = targetSet.bodySims.length;
  targetSet.bodySims.push(sim);
  sim.flags &= ~BODY_TRANSIENT_FLAGS;

  removeBodySim(sourceSet, sourceIndex, storage);

  if (sourceSet.setIndex === AWAKE_SET) {
    swapRemove(sourceSet.bodyStates, sourceIndex);
  } else if (targetSet.setIndex === AWAKE_SET) {
    targetSet.bodyStates.push(makeIdentityBodyState(sim.flags));
  }

  body.setIndex = targetSet.setIndex;
  body.localIndex = targetIndex;
}

function removeBodySim(set: SolverSet, localIndex: number, storage: BodyStorage): void {
  const moved = swapRemove(set.bodySims, localIndex);
  if (moved !== undefined) {
    storage.get(moved.bodyId).localIndex = localIndex;
  }
}
