import { type ComponentInstance, type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  directInjectEids,
  getInjected,
  getInjectedWithSrc,
  injectArity,
  isCursorMarker,
  Iter,
  mapInject,
  wantsIter,
  type InjectElement,
  type InjectTuple,
  type RequiredResolvedInjectTuple,
} from "../inject.js";
import { Tracking } from "./query.03.tracking.js";

export class Callbacks<R extends ComponentType[] = []> extends Tracking<R> {
  public enter<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter(callback: (e: Entity) => void): this;
  public enter<J extends InjectTuple>(
    arg0: InjectTuple | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: InjectTuple | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
      this._enterCallback = arg0 as (e: Entity) => void;
      return this;
    }
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
    const inject = mapInject(this.world, components);
    const arity = injectArity(inject);
    if (useIter) {
      this._enterCallback = (e: Entity) => {
        const injected = new Array(arity);
        const it = new Iter(arity);
        it.entity = e;
        getInjectedWithSrc(e, inject, injected, it.src, true);
        cb(it, injected as any);
      };
    } else {
      this._enterCallback = (e: Entity) => {
        const injected = new Array(arity);
        getInjected(e, inject, true, injected);
        cb(e, injected as any);
      };
    }
    return this;
  }

  public exit<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit(callback: (e: Entity) => void): this;
  public exit<J extends InjectTuple>(
    arg0: readonly [...J] | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: readonly [...J] | ((...args: any[]) => void),
    arg2?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
      this._exitCallback = arg0 as (e: Entity) => void;
      this._exitSnapshotTypes = undefined;
      return this;
    }
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
    const inject = mapInject(this.world, components);
    this._exitSnapshotTypes = directInjectEids(inject);
    const arity = injectArity(inject);
    if (useIter) {
      this._exitCallback = (e: Entity, exitSnapshot?: Map<number, ComponentInstance>) => {
        const injected = new Array(arity);
        const it = new Iter(arity);
        it.entity = e;
        getInjectedWithSrc(e, inject, injected, it.src, true, exitSnapshot);
        cb(it, injected as any);
      };
    } else {
      this._exitCallback = (e: Entity, exitSnapshot?: Map<number, ComponentInstance>) => {
        const injected = new Array(arity);
        getInjected(e, inject, true, injected, exitSnapshot);
        cb(e, injected as any);
      };
    }
    return this;
  }
}
