import type { Entity } from "../entity/index.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /**
   * @internal Per-world registry mapping a component class to its
   * component-entity. A `WeakMap` keeps the lookup off the (global, shared)
   * class objects, so registering the same class across many worlds never
   * forces those classes into dictionary mode and slows every property access.
   */
  public readonly _classRegistry = new WeakMap<object, Entity>();
}
