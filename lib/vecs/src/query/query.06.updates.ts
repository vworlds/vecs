import { type ComponentInstance, type ComponentType } from "../component.js";
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
import { Sort } from "./query.05.sort.js";

export class Updates<R extends ComponentType[] = []> extends Sort<R> {
  public update<C extends ComponentType>(
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType, J extends InjectTuple>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType, J extends InjectTuple>(
    cursor: typeof Entity,
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType>(
    cursor: typeof Entity,
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType, J extends InjectTuple>(
    cursor: typeof Iter,
    ComponentClass: C,
    inject: readonly [...J],
    callback: (it: Iter, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType>(
    arg0: C | typeof Entity | typeof Iter,
    arg1: C | readonly InjectElement[] | ((...args: any[]) => void),
    arg2?: readonly InjectElement[] | ((...args: any[]) => void),
    arg3?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    const useIter = wantsIter(arg0);
    if (isCursorMarker(arg0)) {
      arg0 = arg1 as C;
      arg1 = arg2 as readonly InjectElement[];
      arg2 = arg3 as (...args: any[]) => void;
    }
    const ComponentClass = arg0 as C;
    const componentEid = this.world.entity(ComponentClass).eid;
    if (typeof arg1 === "function") {
      const callback = arg1 as (...args: any[]) => void;
      this._componentUpdateCallbacks.set(componentEid, callback);
    } else {
      const components = arg1 as readonly InjectElement[];
      const callback = arg2 as (...args: any[]) => void;
      const inject = mapInject(this.world, components);
      const arity = injectArity(inject);
      const injected = new Array(arity);
      if (useIter) {
        const it = new Iter(arity);
        const cb = (e: Entity, c: ComponentInstance) => {
          it.entity = e;
          getInjectedWithSrc(e, inject, injected, it.src);
          callback(it, c as InstanceType<C>, injected as any);
        };
        this._componentUpdateCallbacks.set(componentEid, cb);
      } else {
        const cb = (e: Entity, c: ComponentInstance) => {
          getInjected(e, inject, false, injected);
          callback(e, c as InstanceType<C>, injected as any);
        };
        this._componentUpdateCallbacks.set(componentEid, cb);
      }
    }
    this._watchlistBitmask.add(componentEid);
    if (!this._hasExplicitQuery) {
      this._dsl = this._watchlistBitmask.indices();
    }
    return this;
  }
}
