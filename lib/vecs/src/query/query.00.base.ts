import { ArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { type ComponentInstance, type ComponentType } from "../component.js";
import { type QueryDSL } from "../dsl.js";
import { Entity } from "../entity/index.js";
import { type World } from "../world/index.js";
import { type Term } from "../terms/term.js";

export const SOURCE_TRACKED_QUERY_ERROR =
  "source/children is not supported in a tracked query; use world.filter(...)";

export const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();

type EntityCallback = (e: Entity, snapshot?: Map<number, ComponentInstance>) => void;
type ComponentCallback = (e: Entity, c: ComponentInstance) => void;

let _GroupedQueryCtor: new (...args: any[]) => any;
export function _setGroupedQueryCtor(ctor: new (...args: any[]) => any): void {
  _GroupedQueryCtor = ctor;
}
export function _getGroupedQueryCtor(): new (...args: any[]) => any {
  return _GroupedQueryCtor;
}

export class Base<R extends ComponentType[] = []> {
  /** @internal Sorted projection. Unsorted membership is read from `rootTerm`. */
  protected _entities: Set<Entity> | undefined;
  /** @internal `true` once `query` or `requires` has set an explicit predicate. */
  protected _hasExplicitQuery: boolean = false;
  /** @internal DSL predicate used to build the root membership term. */
  public _dsl: QueryDSL | undefined = undefined;
  /** Entity that stores this query as a component and carries query traits. */
  public readonly entity: Entity;
  /** @internal `true` once this query has been registered with its world. */
  protected _built = false;
  /** @internal Guards destroy hooks against recursive removal. */
  protected _destroyed = false;
  /** @internal Whether membership APIs are enabled for this query. */
  public _tracking = false;
  /** Materialized root term that owns membership for this query. */
  public rootTerm: Term | undefined;
  /** @internal Root term subscription handle. */
  protected _unsubscribeTerm: (() => void) | undefined;

  /** @internal `enter` callback (already wraps any injection logic). */
  public _enterCallback: EntityCallback | undefined = undefined;
  /** @internal `exit` callback (already wraps any injection logic). */
  public _exitCallback: EntityCallback | undefined = undefined;
  /** @internal Component eids the exit callback needs snapshotted before component removal. */
  public _exitSnapshotTypes: number[] | undefined = undefined;
  /** @internal Per-component-eid `update` callbacks. */
  protected _componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Bitmask of component eids this query reacts to via `update`. */
  public _watchlistBitmask: Bitset = new Bitset();
  /** @internal Silence-domain query cache. */
  public _silenceQuery: { has(e: Entity): boolean } | undefined;
  /** @internal Component class for membership checks. */
  protected _queryComponentClass: ComponentType;

  constructor(name: string, world: World, componentClass: ComponentType, track: boolean = true) {
    this._queryComponentClass = componentClass;
    this.entity = world.entity();
    this.entity.name = name;
    this.entity.attach(componentClass, this);
    world._addUnbuiltQuery(this as any);
    if (track) {
      (this as any).track();
    }
  }

  /** @internal Throw when a builder method is called after registration. */
  protected _assertConfigurable(): void {
    if (this.built) {
      throw new Error(`query '${this.name}' has already been built`);
    }
  }

  /** @internal Whether this object has enough configuration to enter the world. */
  protected _isBuildable(): boolean {
    return this._dsl !== undefined;
  }

  /** `true` once this query has been registered with its world. */
  public get built(): boolean {
    return this._built;
  }

  /** Unique display name; forwards to the backing entity identity. */
  public get name(): string | undefined {
    return this.entity.name;
  }

  /** World that owns this query; forwards to the backing entity. */
  public get world(): World {
    return this.entity.world;
  }

  /** Returns the query name. */
  public toString(): string {
    return this.name ?? "";
  }

  /** @internal */
  protected _matchedEntities(): ReadonlySet<Entity> | Term {
    if (!this._tracking) {
      return EMPTY_ENTITIES;
    }
    return this._entities ?? this.rootTerm ?? EMPTY_ENTITIES;
  }
}
