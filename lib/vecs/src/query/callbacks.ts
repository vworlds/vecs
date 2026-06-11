import { type ComponentInstance, type ComponentType } from "../component.js";
import { Entity, type EID } from "../entity/index.js";
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
} from "../inject.js";
import { OrderedSet } from "../util/ordered_set.js";
import { type World } from "../world/index.js";

export type EntityCallback = (e: Entity, snapshot?: Map<EID, ComponentInstance>) => void;
export type ComponentCallback = (e: Entity, c: ComponentInstance) => void;

export function makeEnterCallback(
  world: World,
  arg0: InjectTuple | ((e: Entity) => void) | typeof Entity | typeof Iter,
  arg1?: InjectTuple | Function,
  arg2?: Function
): EntityCallback {
  if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
    return arg0 as (e: Entity) => void;
  }
  const useIter = wantsIter(arg0);
  const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
  const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
  const inject = mapInject(world, components);
  const arity = injectArity(inject);
  if (useIter) {
    return (e: Entity) => {
      const injected = new Array(arity);
      const it = new Iter(arity);
      it.entity = e;
      getInjectedWithSrc(e, inject, injected, it.src, true);
      cb(it, injected as any);
    };
  }
  return (e: Entity) => {
    const injected = new Array(arity);
    getInjected(e, inject, true, injected);
    cb(e, injected as any);
  };
}

export function makeExitCallback(
  world: World,
  arg0: readonly unknown[] | ((e: Entity) => void) | typeof Entity | typeof Iter,
  arg1?: readonly unknown[] | ((...args: any[]) => void),
  arg2?: (...args: any[]) => void
): { callback: EntityCallback; snapshotTypes: EID[] | undefined } {
  if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
    return { callback: arg0 as (e: Entity) => void, snapshotTypes: undefined };
  }
  const useIter = wantsIter(arg0);
  const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
  const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
  const inject = mapInject(world, components);
  const snapshotTypes = directInjectEids(inject);
  const arity = injectArity(inject);
  if (useIter) {
    const callback = (e: Entity, exitSnapshot?: Map<EID, ComponentInstance>) => {
      const injected = new Array(arity);
      const it = new Iter(arity);
      it.entity = e;
      getInjectedWithSrc(e, inject, injected, it.src, true, exitSnapshot);
      cb(it, injected as any);
    };
    return { callback, snapshotTypes };
  }
  const callback = (e: Entity, exitSnapshot?: Map<EID, ComponentInstance>) => {
    const injected = new Array(arity);
    getInjected(e, inject, true, injected, exitSnapshot);
    cb(e, injected as any);
  };
  return { callback, snapshotTypes };
}

export function makeSortedEntitySet(
  world: World,
  arg0: readonly InjectElement[] | typeof Entity | typeof Iter,
  arg1?: readonly InjectElement[] | Function,
  arg2?: Function
): { set: OrderedSet<Entity>; watchEids: EID[] } {
  const useIter = wantsIter(arg0);
  const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
  const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (...args: unknown[]) => number;
  const inject = mapInject(world, components);
  const arity = injectArity(inject);
  const watchEids = directInjectEids(inject);
  if (useIter) {
    const itA = new Iter(arity);
    const itB = new Iter(arity);
    const resolvedA = new Array(arity);
    const resolvedB = new Array(arity);
    const set = new OrderedSet<Entity>((a, b) => {
      itA.entity = a;
      itB.entity = b;
      getInjectedWithSrc(a, inject, resolvedA, itA.src);
      getInjectedWithSrc(b, inject, resolvedB, itB.src);
      return cb(itA, resolvedA, itB, resolvedB) || a.eid - b.eid;
    });
    return { set, watchEids };
  }
  const resolvedA = new Array(arity);
  const resolvedB = new Array(arity);
  const set = new OrderedSet<Entity>((a, b) => {
    getInjected(a, inject, false, resolvedA);
    getInjected(b, inject, false, resolvedB);
    return cb(a, resolvedA, b, resolvedB) || a.eid - b.eid;
  });
  return { set, watchEids };
}

export function makeUpdateRegistration<C extends ComponentType>(
  world: World,
  arg0: C | typeof Entity | typeof Iter,
  arg1: C | readonly InjectElement[] | ((...args: any[]) => void),
  arg2?: readonly InjectElement[] | ((...args: any[]) => void),
  arg3?: (...args: any[]) => void
): { componentEid: EID; callback: ComponentCallback } {
  const useIter = wantsIter(arg0);
  if (isCursorMarker(arg0)) {
    arg0 = arg1 as C;
    arg1 = arg2 as readonly InjectElement[];
    arg2 = arg3 as (...args: any[]) => void;
  }
  const ComponentClass = arg0 as C;
  const componentEid = world.entity(ComponentClass).eid;
  if (typeof arg1 === "function") {
    return { componentEid, callback: arg1 as ComponentCallback };
  }
  const components = arg1 as readonly InjectElement[];
  const callback = arg2 as (...args: any[]) => void;
  const inject = mapInject(world, components);
  const arity = injectArity(inject);
  const injected = new Array(arity);
  if (useIter) {
    const it = new Iter(arity);
    const cb = (e: Entity, c: ComponentInstance) => {
      it.entity = e;
      getInjectedWithSrc(e, inject, injected, it.src);
      callback(it, c as InstanceType<C>, injected as any);
    };
    return { componentEid, callback: cb };
  }
  const cb = (e: Entity, c: ComponentInstance) => {
    getInjected(e, inject, false, injected);
    callback(e, c as InstanceType<C>, injected as any);
  };
  return { componentEid, callback: cb };
}
