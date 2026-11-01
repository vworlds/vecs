import type { EID, Entity } from "../entity/index.js";
import type { ComponentInstance } from "../component_meta.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /** @internal Removed slot available only to injection during synchronous exit routing. */
  public _removalInFlight: { entity: Entity; ceid: EID; instance: ComponentInstance } | undefined =
    undefined;

  /** @internal Suspend cleanup policies only during dispose's infrastructure pass. */

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

  /**
   * @internal Entity of the system currently running, or `undefined` outside a
   * system. Stamped onto every command at enqueue time so the originating
   * system survives until the command is routed (see {@link System._run}).
   */
  public _currentSource: Entity | undefined = undefined;

  /**
   * @internal Source entity of the command currently being applied. Read by
   * {@link Query._notifyModified} to silence updates from ignored sources;
   * cleared once the command queue drains.
   */
  public _routingSource: Entity | undefined = undefined;
}
