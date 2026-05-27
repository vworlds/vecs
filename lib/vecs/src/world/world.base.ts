import type { Entity } from "../entity/index.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /**
   * @internal Per-world registry mapping a component class to its
   * component-entity. The registry is per-world so the lookup stays off the
   * global component class objects while keeping repeated class lookups fast.
   */
  public readonly _classRegistry = new Map<object, Entity>();

  /**
   * @internal Name -> entity index populated by {@link IdentityModule} hooks.
   * Duplicate names are last-writer-wins.
   */
  public readonly _identityNameIndex = new Map<string, Entity>();

  /**
   * @internal Tracks the last indexed name per entity so that renames,
   * removals, and destroy cleanup can delete stale entries safely.
   */
  public readonly _identityIndexedNames = new WeakMap<Entity, string>();
}
