import { type Entity } from "@vworlds/vecs";

import { Body } from "../body/components.js";
import { type b2BodyId } from "../adapter/engine.js";

/** Resolve the WASM body id for a force/impulse target entity.
 * Accepts entities that directly carry `Body` OR have a `Body`-carrying
 * immediate parent via `ChildOf`. Returns `undefined` when neither applies. */
export function resolveBodyId(entity: Entity): b2BodyId | undefined {
  const body = entity.get(Body);
  if (body !== undefined) {
    return body._bodyId;
  }

  return entity.parent?.get(Body)?._bodyId;
}
