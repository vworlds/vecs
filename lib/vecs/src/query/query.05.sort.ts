import { type ComponentRef, type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  getInjected,
  getInjectedWithSrc,
  injectArity,
  isCursorMarker,
  Iter,
  mapInject,
  wantsIter,
  type InjectElement,
  type InjectTuple,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { Traversable } from "../modules/relationships.js";
import { OrderedSet } from "../util/ordered_set.js";
import { Callbacks } from "./query.04.callbacks.js";

export class Sort<R extends ComponentType[] = []> extends Callbacks<R> {
  public cascade(rel: ComponentRef): this;
  public cascade(rel: ComponentRef, compare: (a: Entity, b: Entity) => number): this;
  public cascade(rel: ComponentRef, compare?: (a: Entity, b: Entity) => number): this {
    this._assertConfigurable();
    const relEntity = this.world.entity(rel);
    const relMeta = relEntity.ownMeta;
    if (!relMeta.isRelationship) {
      throw new Error(`Component ${relMeta.Class.name} is not a Relationship`);
    }

    const traversable = relEntity.get(Traversable);
    if (!traversable) {
      throw new Error(`Relationship ${relMeta.Class.name} does not have the Traversable trait`);
    }

    const depths = traversable.depths;
    return this.sort([], (a, _ra, b) => {
      const da = depths.get(a) ?? -1;
      const db = depths.get(b) ?? -1;
      return da - db || compare?.(a, b) || 0;
    });
  }

  public sort<J extends InjectTuple>(
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public sort<J extends InjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public sort<J extends InjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    compare: (
      a: Iter,
      aResolved: MaybeResolvedInjectTuple<J, R>,
      b: Iter,
      bResolved: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public sort(
    arg0: readonly InjectElement[] | typeof Entity | typeof Iter,
    arg1?: readonly InjectElement[] | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (...args: unknown[]) => number;
    const inject = mapInject(this.world, components);
    const arity = injectArity(inject);
    this._tracking = true;
    if (useIter) {
      const itA = new Iter(arity);
      const itB = new Iter(arity);
      const resolvedA = new Array(arity);
      const resolvedB = new Array(arity);
      this._entities = new OrderedSet<Entity>((a, b) => {
        itA.entity = a;
        itB.entity = b;
        getInjectedWithSrc(a, inject, resolvedA, itA.src);
        getInjectedWithSrc(b, inject, resolvedB, itB.src);
        return cb(itA, resolvedA, itB, resolvedB) || a.eid - b.eid;
      });
    } else {
      const resolvedA = new Array(arity);
      const resolvedB = new Array(arity);
      this._entities = new OrderedSet<Entity>((a, b) => {
        getInjected(a, inject, false, resolvedA);
        getInjected(b, inject, false, resolvedB);
        return cb(a, resolvedA, b, resolvedB) || a.eid - b.eid;
      });
    }
    return this;
  }
}
