import type { Entity } from "../entity/index.js";
import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /** @internal Depth of constructor-like component and relationship add hooks. */
  public _initializationDepth = 0;
  /** @internal Depth of atomic deletion validation. */
  public _deletionPreflightDepth = 0;
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
  public _currentSource: Entity | undefined;

  /**
   * @internal Source entity of the command currently being applied. Read by
   * {@link Query._notifyModified} to silence updates from ignored sources;
   * cleared once the command queue drains.
   */
  public _routingSource: Entity | undefined;

  /** @internal Run constructor-like hooks under the query-build and mutation guard. */
  public _runInitializer<T>(callback: () => T): T {
    this._initializationDepth++;
    try {
      return callback();
    } finally {
      this._initializationDepth--;
    }
  }

  /** @internal Reject structural mutation while a deletion validator is running. */
  public _assertStructuralMutationAllowed(): void {
    if (this._deletionPreflightDepth > 0) {
      throw new Error("structural mutation is forbidden during deletion preflight");
    }
  }

  /** @internal Run one validator under the deletion-preflight mutation guard. */
  public _runDeletionPreflight<T>(callback: () => T): T {
    this._deletionPreflightDepth++;
    try {
      return callback();
    } finally {
      this._deletionPreflightDepth--;
    }
  }
}
