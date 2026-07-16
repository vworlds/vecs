import { ComponentMeta, type ComponentInstance, type ComponentType } from "../component_meta.js";
import type { Query } from "../query/index.js";
import { IterableArrayMap, type ReadonlyIterableArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { DenseSet } from "../util/dense_set.js";
import type { World } from "../world/index.js";
import type { EID, Entity } from "./entity.js";

export class Base {
  /** @internal Metadata for this entity when the entity itself is used as a component key. */
  protected _meta: ComponentMeta | undefined;

  /** @internal Maps component eid to component instance. */
  protected _components = new IterableArrayMap<ComponentInstance>();
  /** @internal Component eids with pending modified delivery. */
  protected readonly _dirtyComponentBitmask = new Bitset();
  /** @internal Set of queries this entity currently belongs to. */
  protected readonly _queries = new Set<Query>();

  /** @internal Empty incoming set used when no entities target this one. */
  protected static readonly _emptyIncoming: ReadonlySet<Entity> = new Set();

  /** @internal Relationship eid -> source entities targeting this entity. */
  protected _incoming: IterableArrayMap<DenseSet<Entity>> | undefined;

  /**
   * Bitmask of component type ids currently attached to this entity. Used by
   * the world for fast archetype matching against query predicates.
   */
  public readonly componentBitmask = new Bitset();

  protected _destroyed: boolean = false;

  constructor(
    /** World that owns this entity. */
    public readonly world: World,
    /** Unique numeric entity id assigned at creation. */
    public readonly eid: EID,
    ownComponentClass?: ComponentType
  ) {
    if (ownComponentClass !== undefined) {
      this._meta = new ComponentMeta(ownComponentClass, eid);
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
  public get components(): ReadonlyIterableArrayMap<ComponentInstance> {
    return this._components;
  }

  /** `true` when no components are currently attached to this entity. */
  public get empty(): boolean {
    return this._components.size == 0;
  }

  /** Metadata for using this entity's eid as a component key. Created lazily for plain entities. */
  public get meta(): ComponentMeta {
    return (this._meta ??= new ComponentMeta(Object, this.eid));
  }

  /** Number of attached component instances, including one currently running its add hooks. */
  public instanceCount(): number {
    return this._meta?.usageCount ?? 0;
  }

  /** Returns `"EntityN"` where N is the entity id. */
  public toString(): string {
    return `Entity${this.eid}`;
  }
}
