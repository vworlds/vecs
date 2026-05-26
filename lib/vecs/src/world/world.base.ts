import type { Entity } from "../entity/index.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /** Hidden property key used to store this world's meta on component classes. */
  public readonly worldKey = `__vecs_world_${Math.random().toString(36).slice(2)}`;

  /**
   * @internal Per-world registry mapping a component class to its
   * component-entity. Replaces stashing the entity on the class under
   * {@link worldKey}: a `WeakMap` keeps the lookup off the (global, shared)
   * class objects, so registering the same class across many worlds never
   * forces those classes into dictionary mode and slows every property access.
   */
  public readonly _classRegistry = new WeakMap<object, Entity>();
}
