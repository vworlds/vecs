import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";

export const enum TermEventKind {
  Enter,
  Exit,
}

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

  public onTermEvent(_kind: TermEventKind, entity: Entity): void {
    this._sync(entity);
  }

  public onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

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

  /** @internal */
  protected _add(entity: Entity): void {
    if (this._entities.has(entity)) {
      return;
    }
    this._entities.add(entity);
    this._emit(TermEventKind.Enter, entity);
  }

  /** @internal */
  protected _delete(entity: Entity): void {
    if (!this._entities.delete(entity)) {
      return;
    }
    this._emit(TermEventKind.Exit, entity);
  }

  /** @internal */
  protected _emitRefresh(entity: Entity): void {
    this._consumers.forEach((consumer) => consumer.onTermRefresh?.(entity));
  }

  /** @internal */
  protected _addChildCleanup(cleanup: () => void): void {
    this._childUnsubscribes.push(cleanup);
  }

  /** @internal */
  protected _initializeFromWorld(): void {
    this.world.entities.forEach((entity) => {
      if (this._matches(entity)) {
        this._entities.add(entity);
      }
    });
  }

  /** @internal */
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

  /** @internal */
  protected _onChildEvent(kind: TermEventKind, entity: Entity, _child: Term): void {
    this.onTermEvent(kind, entity);
  }

  /** @internal */
  protected _onChildRefresh(entity: Entity, _child: Term): void {
    this.onTermRefresh(entity);
  }

  /** @internal */
  protected abstract _matches(entity: Entity): boolean;

  /** @internal */
  protected _sync(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    } else {
      this._delete(entity);
    }
  }

  private _emit(kind: TermEventKind, entity: Entity): void {
    this._consumers.forEach((consumer) => consumer.onTermEvent(kind, entity));
  }
}

