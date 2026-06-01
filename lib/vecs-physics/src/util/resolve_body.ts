import { ChildOf, type Entity } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";

/** Resolve the WASM body id for a force/impulse target entity.
 * Accepts entities that directly carry `Body` OR have a `Body`-carrying
 * immediate parent via `ChildOf`. Returns `undefined` when neither applies. */
export function resolveBodyId(entity: Entity, state: PhysicsState): b2BodyId | undefined {
  if (entity.get(Body) !== undefined) {
    return state.bodyByEntityWasm.get(entity.eid);
  }

  const parent = entity.parent(ChildOf);
  if (parent === undefined || parent.get(Body) === undefined) {
    return undefined;
  }
  return state.bodyByEntityWasm.get(parent.eid);
}
