import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";

/** World-pinned leaf term that matches no entities; the materialization of `false`. */
export class EmptyTerm extends Term {
  public constructor(world: World, key: string, onDestroy: (term: Term) => void) {
    super(world, key, "empty", true, onDestroy);
  }

  /** @internal */
  protected _matches(_entity: Entity): boolean {
    return false;
  }
}
