import { ChildOf, type Entity } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { type b2BodyId } from "../adapter/state.js";

/** Resolve the WASM body id for a force/impulse target entity.
 * Accepts entities that directly carry `Body` OR have a `Body`-carrying
 * immediate parent via `ChildOf`. Returns `undefined` when neither applies. */
export function resolveBodyId(entity: Entity): b2BodyId | undefined {
  const body = entity.get(Body);
  if (body !== undefined) {
    return body._bodyId;
  }

  const parent = entity.parent(ChildOf);
  return parent?.get(Body)?._bodyId;
}
