import type { Entity } from "../entity/index.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /**
   * Per-world unique tag. Historically this keyed per-world component metadata
   * stashed on the (shared) component class objects; that storage now lives in
   * {@link _classRegistry}, so the tag is no longer read by the runtime and is
   * retained only for benchmark bookkeeping. See the "Dead `worldKey` field"
   * issue in the cleanup notes.
   */
  public readonly worldKey = `__vecs_world_${Math.random().toString(36).slice(2)}`;

  /**
   * @internal Per-world registry mapping a component class to its
   * component-entity. A `WeakMap` keeps the lookup off the (global, shared)
   * class objects, so registering the same class across many worlds never
   * forces those classes into dictionary mode and slows every property access.
   */
  public readonly _classRegistry = new WeakMap<object, Entity>();
}
