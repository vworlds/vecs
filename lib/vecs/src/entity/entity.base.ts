import { ComponentMeta, type ComponentInstance, type ComponentType } from "../component_meta.js";
import type { Query } from "../query/index.js";
import { ArrayMap, type ReadonlyArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { DenseSet } from "../util/dense_set.js";
import { Events } from "../util/events.js";
import type { World } from "../world/index.js";
import type { Entity } from "./entity.js";

export type EntityEvents = Events<{ destroy(): void }>;

export class Base {
  /** @internal Metadata for this entity when the entity itself is used as a component key. */
  protected _ownMeta: ComponentMeta | undefined;

  /** @internal Maps component eid to component instance. */
  protected _components = new ArrayMap<ComponentInstance>();
  /** @internal Component eids with pending modified delivery. */
  protected readonly _dirtyComponentBitmask = new Bitset();
  /** @internal Set of queries this entity currently belongs to. */
  protected readonly _queries = new Set<Query>();

  /** @internal Empty incoming set used when no entities target this one. */
  protected static readonly _emptyIncoming: ReadonlySet<Entity> = new Set();

  /** @internal Relationship eid -> source entities targeting this entity. */
  protected _incoming: ArrayMap<DenseSet<Entity>> | undefined;

  /**
   * Bitmask of component type ids currently attached to this entity. Used by
   * the world for fast archetype matching against query predicates.
   */
  public readonly componentBitmask = new Bitset();

  /**
   * Free-form property bag. Modules can use it to associate arbitrary data with
   * an entity without registering a dedicated component.
   */
  public properties = new Map<string, any>();

  /** @internal Set to `true` after the world has fully torn down this entity. */
  public _destroyed: boolean = false;

  /** @internal Lazy event emitter, allocated on first {@link events} access. */
  declare public _events: EntityEvents;

  constructor(
    /** World that owns this entity. */
    public readonly world: World,
    /** Unique numeric entity id assigned at creation. */
    public readonly eid: number,
    ownComponentClass?: ComponentType
  ) {
    if (ownComponentClass !== undefined) {
      this._ownMeta = new ComponentMeta(ownComponentClass, eid);
    }
  }

  /**
   * Read-only view of all components currently attached to this entity, keyed
   * by numeric component type id.
   *
   * The mutating methods (`set`, `delete`, `clear`) are not exposed. Use
   * `entity.add`, `entity.attach`, `entity.set`, and `entity.remove` to change
   * the component set.
   *
   * ```ts
   * entity.components.forEach((c) => console.log(c.constructor.name));
   * ```
   */
  public get components(): ReadonlyArrayMap<ComponentInstance> {
    return this._components;
  }

  /** `true` when no components are currently attached to this entity. */
  public get empty(): boolean {
    return this._components.size == 0;
  }

  /**
   * Typed event emitter for entity-level lifecycle events. Currently only the
   * `"destroy"` event is emitted, just before the entity is fully torn down.
   *
   * The emitter is created lazily on first access.
   */
  public get events(): EntityEvents {
    if (!this._events) {
      this._events = new Events();
    }
    return this._events;
  }

  /** Metadata for using this entity's eid as a component key. Created lazily for plain entities. */
  public get ownMeta(): ComponentMeta {
    return (this._ownMeta ??= new ComponentMeta(Object, this.eid));
  }

  /** Number of live component instances currently attached for this entity's component key. */
  public instanceCount(): number {
    return this._ownMeta?.usageCount ?? 0;
  }

  /** Returns `"EntityN"` where N is the entity id. */
  public toString(): string {
    return `Entity${this.eid}`;
  }
}
