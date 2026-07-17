import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";

export const enum TermEventKind {
  Enter,
  Exit,
}

/**
 * Observer interface for a `Term` node.
 *
 * ## Two-signal contract
 *
 * Consumers receive two independent channels:
 *
 * - **`onTermEvent`** — the ordered **membership stream**. Only real
 *   enter/exit flips are emitted here (no spurious duplicates). Every
 *   consumer — including `Query`, `System`, and composite parent terms —
 *   implements this method. It is the sole authoritative source of "who is
 *   in the set".
 *
 * - **`onTermRefresh`** — an *optional* **invalidation hint**. It signals
 *   that an entity's data or shape changed but membership *may* not have.
 *   Only composite terms that need to pull-recompute on data changes
 *   (e.g. `PredicateTerm`, `OnlyTerm`) implement this; membership-only
 *   consumers such as `Query` omit it and are never woken by pure data
 *   updates. The `?` makes the method optional so implementors that do not
 *   care about data refreshes pay zero overhead.
 */
export interface TermConsumer {
  /** Ordered membership stream. Only real enter/exit flips are emitted here. */
  onTermEvent(kind: TermEventKind, entity: Entity): void;
  /**
   * @internal Non-membership invalidation for shape/data re-evaluation.
   * Component update callbacks still use the entity slim update set; refreshes
   * only let predicate/shape terms pull-recompute after watched data changes.
   */
  onTermRefresh?(entity: Entity): void;
}

export type TermKind =
  | "world"
  | "component"
  | "empty"
  | "all"
  | "any"
  | "not"
  | "only"
  | "predicate"
  | "target"
  | "merged";

/**
 * Base class for all reactive entity-set nodes in the term graph.
 *
 * A `Term` maintains a live `Set<Entity>` of every entity currently satisfying
 * its sub-predicate. It subscribes to its children via the two-signal contract
 * defined on {@link TermConsumer} and propagates enter/exit events upward to
 * its own consumers.
 *
 * Subclasses implement `_matches` (the membership test) and may override
 * `_onChildEvent`, `_onChildRefresh`, or `onTermRefresh` to customize how
 * signals from children are interpreted.
 */
export abstract class Term implements TermConsumer {
  /** @internal */
  protected readonly _children: Term[] = [];
  /** @internal */
  protected readonly _consumers = new Set<TermConsumer>();
  /** @internal */
  protected readonly _entities = new Set<Entity>();
  private _destroyed = false;
  private readonly _childUnsubscribes: (() => void)[] = [];

  protected constructor(
    public readonly world: World,
    public readonly key: string,
    public readonly kind: TermKind,
    private readonly _pinned: boolean,
    private readonly _onDestroy: (term: Term) => void
  ) {}

  public get count(): number {
    return this._entities.size;
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
  }

  public children(): readonly Term[] {
    return this._children;
  }

  public has(entity: Entity): boolean {
    return this._entities.has(entity);
  }

  /**
   * Default membership-event handler: re-run `_matches` and add/remove
   * accordingly. Composite terms typically let this default run; leaf terms
   * use explicit `_add`/`_delete` calls instead and never receive child events.
   */
  public onTermEvent(_kind: TermEventKind, entity: Entity): void {
    this._sync(entity);
  }

  /**
   * Default invalidation-hint handler: re-run `_matches` via `_sync`.
   *
   * Terms that should *not* re-evaluate on a data/shape refresh (e.g.
   * `NotTerm`) override this with a no-op. Terms that need the shape channel
   * but want to override the full handler (e.g. `OnlyTerm`) override with a
   * call to `_sync` as well — this default is already correct for most cases.
   */
  public onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

  /**
   * Add `consumer` to the set of active consumers and return an unsubscribe
   * function.
   *
   * Consumer count drives term lifetime: when the count falls to zero on a
   * non-pinned term the term destroys itself and cascades destruction to
   * children. Calling the unsubscribe function more than once is safe (idempotent).
   *
   * @throws If the term has already been destroyed.
   */
  public subscribe(consumer: TermConsumer): () => void {
    if (this._destroyed) {
      throw new Error(`Cannot subscribe to destroyed ${this.kind} term`);
    }
    this._consumers.add(consumer);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this._consumers.delete(consumer);
      if (!this._pinned && this._consumers.size === 0) {
        this.destroy();
      }
    };
  }

  /**
   * Permanently destroy this term.
   *
   * Clears all consumers, unsubscribes from all children (cascading
   * destruction when their consumer counts reach zero), clears the entity
   * set, and calls `_onDestroy` to remove the term from the world cache.
   * Pinned terms (`WorldTerm`, `ComponentTerm`, `EmptyTerm`) ignore this call.
   */
  public destroy(): void {
    if (this._destroyed || this._pinned) {
      return;
    }
    this._destroyed = true;
    this._consumers.clear();
    while (this._childUnsubscribes.length > 0) {
      this._childUnsubscribes.pop()!();
    }
    this._entities.clear();
    this._onDestroy(this);
  }

  /** @internal Emit an enter event and add entity; no-op if already present. */
  protected _add(entity: Entity): void {
    if (this._entities.has(entity)) {
      return;
    }
    this._entities.add(entity);
    this._emit(TermEventKind.Enter, entity);
  }

  /** @internal Emit an exit event and remove entity; no-op if not present. */
  protected _delete(entity: Entity): void {
    if (!this._entities.delete(entity)) {
      return;
    }
    this._emit(TermEventKind.Exit, entity);
  }

  /** @internal Propagate a refresh hint to all consumers (both channels). */
  protected _emitRefresh(entity: Entity): void {
    for (const consumer of [...this._consumers]) {
      consumer.onTermRefresh?.(entity);
    }
  }

  /** @internal Register an additional cleanup callback run during `destroy`. */
  protected _addChildCleanup(cleanup: () => void): void {
    this._childUnsubscribes.push(cleanup);
  }

  /**
   * @internal Seed the entity set from the current world state without
   * emitting events.
   *
   * Called once at the end of construction so the term starts up-to-date
   * before any consumers subscribe.
   */
  protected _initializeFromWorld(): void {
    this.world.entities.forEach((entity) => {
      if (this._matches(entity)) {
        this._entities.add(entity);
      }
    });
  }

  /**
   * @internal Register `children` as this term's child nodes.
   *
   * For each child, subscribes **both** channels via an anonymous
   * `TermConsumer` that routes to `_onChildEvent` and `_onChildRefresh`.
   * Registering both channels here (rather than in subclass constructors)
   * ensures that every composite term receives refresh hints without
   * boilerplate — subclasses then filter in `_onChildRefresh` to decide
   * whether to act.
   */
  protected _setChildren(children: readonly Term[]): void {
    this._children.push(...children);
    children.forEach((child) => {
      this._childUnsubscribes.push(
        child.subscribe({
          onTermEvent: (kind, entity) => this._onChildEvent(kind, entity, child),
          onTermRefresh: (entity) => this._onChildRefresh(entity, child),
        })
      );
    });
  }

  /**
   * @internal Default child membership-event handler: forward to
   * `onTermEvent`. Composite terms (e.g. `TargetTerm`) override this to
   * implement non-trivial fan-out logic.
   */
  protected _onChildEvent(kind: TermEventKind, entity: Entity, _child: Term): void {
    this.onTermEvent(kind, entity);
  }

  /**
   * @internal Default child refresh handler: forward to `onTermRefresh`.
   *
   * Most composites delegate to `onTermRefresh` which defaults to `_sync`.
   * Subclasses that only want to react to *specific* child kinds (e.g.
   * `PredicateTerm` reacting only to component-kind children) override this
   * to filter before calling `_sync`.
   */
  protected _onChildRefresh(entity: Entity, _child: Term): void {
    this.onTermRefresh(entity);
  }

  /** @internal The membership predicate for this term. Implemented by each subclass. */
  protected abstract _matches(entity: Entity): boolean;

  /**
   * @internal Pull-recompute membership for `entity`.
   *
   * Re-evaluates `_matches` and calls `_add` or `_delete`. Because `_add` and
   * `_delete` are idempotent, `_sync` is safe to call redundantly — it emits
   * an event only on a real flip, which is the core of the glitch-free
   * propagation guarantee.
   */
  protected _sync(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    } else {
      this._delete(entity);
    }
  }

  /** @internal Emit a membership transition without changing this term's local set. */
  protected _emit(kind: TermEventKind, entity: Entity): void {
    for (const consumer of [...this._consumers]) {
      if (
        (kind === TermEventKind.Enter && !this.has(entity)) ||
        (kind === TermEventKind.Exit && this.has(entity))
      ) {
        break;
      }
      consumer.onTermEvent(kind, entity);
    }
  }
}
