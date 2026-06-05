import {
  type ComponentRef,
  type ComponentInstance,
  type ComponentMeta,
  type ComponentType,
} from "../component.js";
import { _resolveRelationship } from "../dsl.js";
import { Entity } from "../entity/index.js";
import {
  directInjectEids,
  getInjected,
  injectArity,
  mapInject,
  type FanInjectElement,
} from "../inject.js";
import { type World } from "../world/index.js";
import { _setGroupedQueryCtor } from "./query.00.base.js";
import { Group, Grouping } from "./query.08.groups.js";
import { Groups } from "./query.08.groups.js";

/**
 * A reactive, always-up-to-date set of entities matching a {@link QueryDSL}
 * predicate.
 *
 * `Query` listens to entity / component mutations through the world's command
 * queue and tracks which entities currently satisfy its predicate. It fires
 * `enter`, `exit`, and `update` callbacks as the matched set changes. The
 * tracked set is exposed via {@link count}, {@link has}, iteration, and
 * {@link forEach}.
 *
 * Callbacks fire **synchronously** when the world routes a command — so
 * mutations made inside one of these callbacks are themselves observed
 * immediately by other queries / systems.
 *
 * {@link System} extends `Query` and queues callbacks into an inbox replayed
 * during `_run` instead of firing them immediately. Use `Query` directly when
 * you want a reactive entity set without pipeline integration.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity
 *   (declared via {@link requires} or the `_guaranteed` hint of {@link query}).
 *   Components in `R` appear as non-nullable in {@link sort}, {@link forEach},
 *   and {@link update} callback tuples.
 */
export class Query<R extends ComponentType[] = []> extends Groups<R> {
  constructor(name: string, world: World, track: boolean = true) {
    super(name, world, Query as ComponentType, track);
  }
}

const EMPTY_GROUPS: ReadonlyMap<unknown, Group> = new Map();

/**
 * A {@link Query} that has been partitioned by {@link Query.groupBy}. Adds the
 * typed group-accessor surface ({@link group}, {@link groups}, etc.) on top of
 * the query's usual reactive membership.
 *
 * `GroupedQuery` lives in the query module alongside `Query`. Instances are
 * created lazily by {@link Query.groupBy} via `Object.setPrototypeOf`.
 *
 * @typeParam K - The grouping key type produced by the key function (or the
 *   relationship target entity, for the relationship form).
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class GroupedQuery<K = unknown, R extends ComponentType[] = []> extends Query<R> {
  private _grouping!: Grouping;

  /** @internal */
  public _initialize(
    arg0: readonly FanInjectElement[] | ComponentRef,
    arg1?: (e: Entity, resolved: any) => any
  ): this {
    if (this._grouping !== undefined) {
      throw `query '${this.name}' is already grouped`;
    }
    let keyOf: (e: Entity) => unknown;
    let watchEids: number[];
    if (typeof arg1 === "function") {
      const components = arg0 as readonly FanInjectElement[];
      const inject = mapInject(this.world, components);
      const arity = injectArity(inject);
      const resolved = new Array(arity);
      keyOf = (e: Entity) => {
        getInjected(e, inject, false, resolved);
        return arg1(e, resolved);
      };
      watchEids = directInjectEids(inject);
      this._composeGroupMembership(components);
    } else {
      const relEid = _resolveRelationship(arg0 as ComponentRef, this.world);
      keyOf = (e: Entity) => e.parent(relEid);
      watchEids = [relEid];
      this._composeGroupMembership([arg0 as ComponentRef]);
    }
    for (const eid of watchEids) {
      this._watchlistBitmask.add(eid);
    }
    this.track();
    this._grouping = new Grouping(this.world, keyOf, watchEids);
    return this;
  }

  /** @internal */
  public override _enter(e: Entity): void {
    this._grouping.enter(e);
    super._enter(e);
  }

  /** @internal */
  public override _exit(e: Entity): void {
    super._exit(e);
    this._grouping.exit(e);
  }

  /** @internal */
  public override _notifyModified(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    super._notifyModified(e, meta, c);
    this._grouping.refresh(e, meta.eid);
  }

  /** @internal */
  public override _watchesUpdates(): boolean {
    return super._watchesUpdates() || true;
  }

  public group(key: K): Group<K, R> | undefined {
    return this._grouping?.get(key) as Group<K, R> | undefined;
  }

  public groups(): IterableIterator<Group<K, R>> {
    return (this._grouping?.groups.values() ?? EMPTY_GROUPS.values()) as IterableIterator<
      Group<K, R>
    >;
  }

  public groupKeys(): IterableIterator<K> {
    return (this._grouping?.keys() ?? EMPTY_GROUPS.keys()) as IterableIterator<K>;
  }

  public get groupCount(): number {
    return this._grouping?.groups.size ?? 0;
  }

  public onGroupEnter(callback: (group: Group<K, R>) => void): this {
    this._assertConfigurable();
    this._grouping?.setOnGroupEnter(callback as (group: Group) => void);
    return this;
  }

  public onGroupExit(callback: (key: K, group: Group<K, R>) => void): this {
    this._assertConfigurable();
    this._grouping?.setOnGroupExit(callback as (key: unknown, group: Group) => void);
    return this;
  }

  private _composeGroupMembership(refs: readonly unknown[]): void {
    const componentRefs = refs.filter(
      (ref): ref is ComponentRef =>
        typeof ref === "number" || typeof ref === "function" || ref instanceof Entity
    );
    if (componentRefs.length === 0) {
      return;
    }
    const existing: any = this._dsl ?? true;
    this._dsl = { all: [existing, ...componentRefs] };
    this._hasExplicitQuery = true;
  }

  public override destroy(): void {
    this._grouping?.clear();
    this._grouping = undefined!;
    super.destroy();
  }
}

_setGroupedQueryCtor(GroupedQuery as any);
