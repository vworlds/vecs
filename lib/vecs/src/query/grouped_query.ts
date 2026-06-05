import { type ComponentInstance, type ComponentRef, type ComponentType } from "../component.js";
import { _resolveRelationship } from "../dsl.js";
import { Entity, type EID } from "../entity/index.js";
import {
  directInjectEids,
  getInjected,
  injectArity,
  mapInject,
  type FanInjectElement,
} from "../inject.js";
import { Group } from "./group.js";
import { Grouping } from "./grouping.js";
import { registerGroupedQueryPrototype } from "./grouped_query_registry.js";
import { Query } from "./query.js";

const EMPTY_GROUPS: ReadonlyMap<unknown, Group> = new Map();

/**
 * A {@link Query} that has been partitioned by {@link Query.groupBy}. Adds the
 * typed group-accessor surface ({@link group}, {@link groups}, etc.) on top of
 * the query's usual reactive membership.
 *
 * Instances are created lazily by {@link Query.groupBy} via
 * `Object.setPrototypeOf`, so callers keep the same configured query object.
 *
 * @typeParam K - The grouping key type produced by the key function (or the
 *   relationship target entity, for the relationship form).
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class GroupedQuery<K = unknown, R extends ComponentType[] = []> extends Query<R> {
  private _grouping!: Grouping;

  public get groupCount(): number {
    return this._grouping?.groups.size ?? 0;
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
  public _initialize(
    arg0: readonly FanInjectElement[] | ComponentRef,
    arg1?: (e: Entity, resolved: any) => any
  ): this {
    if (this._grouping !== undefined) {
      throw `query '${this.name}' is already grouped`;
    }
    let keyOf: (e: Entity) => unknown;
    let watchEids: EID[];
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
    for (const ceid of watchEids) {
      this._watchlistBitmask.add(ceid);
    }
    this.track();
    this._grouping = new Grouping(this.world, keyOf, watchEids);
    return this;
  }

  /** @internal */
  public override _notifyModified(e: Entity, ceid: EID, c: ComponentInstance): void {
    super._notifyModified(e, ceid, c);
    this._grouping.refresh(e, ceid);
  }

  /** @internal */
  public override _watchesUpdates(): boolean {
    return super._watchesUpdates() || true;
  }

  public override destroy(): void {
    this._grouping?.clear();
    this._grouping = undefined!;
    super.destroy();
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
}

registerGroupedQueryPrototype(GroupedQuery.prototype);
