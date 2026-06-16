import { type ComponentInstance, type ComponentType } from "../component.js";
import { Entity, type EID } from "../entity/index.js";
import {
  directInjectEids,
  directInjectSnapshotTypes,
  getInjected,
  getInjectedWithSrc,
  injectArity,
  Iter,
  mapInject,
  wantsIter,
  type InjectElement,
  type InjectSnapshot,
  type InjectSnapshotTypes,
  type InjectTuple,
} from "../inject.js";
import type { InjectCallbackOptions, OrderByOptions, UpdateCallbackOptions } from "./options.js";
import { OrderedSet } from "../util/ordered_set.js";
import { type World } from "../world/index.js";

export type EntityCallback = (e: Entity, snapshot?: InjectSnapshot) => void;
export type ComponentCallback = (e: Entity, c: ComponentInstance) => void;
type CursorCallbackArg = Entity | Iter;
type InjectedValues = readonly (ComponentInstance | undefined)[];
type SortCallback = (
  a: CursorCallbackArg,
  aResolved: InjectedValues,
  b: CursorCallbackArg,
  bResolved: InjectedValues
) => number;

export function makeEnterCallback(
  world: World,
  arg0: InjectTuple | InjectCallbackOptions<InjectTuple> | ((e: Entity) => void),
  arg1?: Function
): { callback: EntityCallback; snapshotTypes: InjectSnapshotTypes | undefined } {
  if (typeof arg0 === "function") {
    // Wrap so the drain's extra snapshot argument never leaks to a plain
    // (non-injecting) enter callback — it observes only the entity.
    const fn = arg0 as (e: Entity) => void;
    return { callback: (e: Entity) => fn(e), snapshotTypes: undefined };
  }
  const { components, useIter } = normalizeInjectCallbackArgs(arg0);
  const cb = arg1 as (eOrIt: CursorCallbackArg, injected: InjectedValues) => void;
  const inject = mapInject(world, components);
  // Mirror exit: capture the injected components so a System's inbox-queued enter
  // still resolves them even if the entity is destroyed before the inbox drains.
  // Snapshots store component references, so live entities see current values.
  const snapshotTypes = directInjectSnapshotTypes(inject);
  const arity = injectArity(inject);
  if (useIter) {
    const callback = (e: Entity, enterSnapshot?: InjectSnapshot) => {
      const injected = new Array(arity);
      const it = new Iter(arity);
      it.entity = e;
      getInjectedWithSrc(e, inject, injected, it.src, true, enterSnapshot);
      cb(it, injected as any);
    };
    return { callback, snapshotTypes };
  }
  const callback = (e: Entity, enterSnapshot?: InjectSnapshot) => {
    const injected = new Array(arity);
    getInjected(e, inject, true, injected, enterSnapshot);
    cb(e, injected as any);
  };
  return { callback, snapshotTypes };
}

export function makeExitCallback(
  world: World,
  arg0: InjectTuple | InjectCallbackOptions<InjectTuple> | ((e: Entity) => void),
  arg1?: (...args: any[]) => void
): { callback: EntityCallback; snapshotTypes: InjectSnapshotTypes | undefined } {
  if (typeof arg0 === "function") {
    return { callback: arg0 as (e: Entity) => void, snapshotTypes: undefined };
  }
  const { components, useIter } = normalizeInjectCallbackArgs(arg0);
  const cb = arg1 as (eOrIt: CursorCallbackArg, injected: InjectedValues) => void;
  const inject = mapInject(world, components);
  const snapshotTypes = directInjectSnapshotTypes(inject);
  const arity = injectArity(inject);
  if (useIter) {
    const callback = (e: Entity, exitSnapshot?: InjectSnapshot) => {
      const injected = new Array(arity);
      const it = new Iter(arity);
      it.entity = e;
      getInjectedWithSrc(e, inject, injected, it.src, true, exitSnapshot);
      cb(it, injected as any);
    };
    return { callback, snapshotTypes };
  }
  const callback = (e: Entity, exitSnapshot?: InjectSnapshot) => {
    const injected = new Array(arity);
    getInjected(e, inject, true, injected, exitSnapshot);
    cb(e, injected as any);
  };
  return { callback, snapshotTypes };
}

export function makeSortedEntitySet(
  world: World,
  arg0: readonly InjectElement[] | OrderByOptions<InjectTuple>,
  arg1?: Function
): { set: OrderedSet<Entity>; watchEids: EID[] } {
  const { components, useIter } = normalizeInjectCallbackArgs(arg0);
  const cb = arg1 as SortCallback;
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
  arg0: C | UpdateCallbackOptions<C, InjectTuple>,
  arg1: (...args: any[]) => void
): { componentEid: EID; callback: ComponentCallback } {
  const normalized = normalizeUpdateCallbackArgs(arg0);
  const { ComponentClass, components, useIter } = normalized;
  const componentEid = world.entity(ComponentClass).eid;
  if (components === undefined) {
    const fn = arg1 as (eOrIt: CursorCallbackArg, c: InstanceType<C>) => void;
    if (useIter) {
      const it = new Iter(0);
      return {
        componentEid,
        callback: (e: Entity, c: ComponentInstance) => {
          it.entity = e;
          fn(it, c as InstanceType<C>);
        },
      };
    }
    return { componentEid, callback: arg1 as ComponentCallback };
  }
  const callback = arg1 as (...args: any[]) => void;
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

function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInjectCallbackArgs(
  arg0: readonly InjectElement[] | InjectCallbackOptions<InjectTuple>
): { components: readonly InjectElement[]; useIter: boolean } {
  if (isOptionsObject(arg0) && "inject" in arg0) {
    return {
      components: arg0.inject as readonly InjectElement[],
      useIter: wantsIter(arg0.cursor),
    };
  }
  return { components: arg0 as readonly InjectElement[], useIter: false };
}

function normalizeUpdateCallbackArgs<C extends ComponentType>(
  arg0: C | UpdateCallbackOptions<C, InjectTuple>
): { ComponentClass: C; components: readonly InjectElement[] | undefined; useIter: boolean } {
  if (isOptionsObject(arg0) && "watch" in arg0) {
    return {
      ComponentClass: arg0.watch as C,
      components: arg0.inject as readonly InjectElement[] | undefined,
      useIter: wantsIter(arg0.cursor),
    };
  }
  return { ComponentClass: arg0 as C, components: undefined, useIter: false };
}
