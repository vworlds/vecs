import { type ComponentInstance, type ComponentRef, type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import { type World } from "./world/index.js";
import { _resolveRelationship, type MaybeRequired } from "./dsl.js";

export type TargetInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  target: readonly [ComponentRef, readonly [...J]];
};
export type DownInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  down: readonly [ComponentRef, readonly [...J]];
};
export type InjectElement = ComponentType | TargetInject;
export type InjectTuple = readonly InjectElement[];
export type FanInjectElement = InjectElement | DownInject;
export type FanInjectTuple = readonly FanInjectElement[];
export type ResolvedInjectTerm =
  | number
  | { target: readonly [number, readonly number[]] }
  | { down: readonly [number, readonly number[]] };

/** Resolves the component instance type for one injected component class. */
type ResolvedComponentInstance<T> = T extends ComponentType ? InstanceType<T> : never;
type OptionalResolvedComponentInstances<J extends readonly ComponentType[]> = {
  [K in keyof J]: InstanceType<J[K]> | undefined;
};
type MaybeResolvedInjectElement<T, R extends ComponentType[]> = T extends ComponentType
  ? [MaybeRequired<T, R>]
  : T extends TargetInject<infer J>
    ? OptionalResolvedComponentInstances<J>
    : T extends DownInject<infer J>
      ? OptionalResolvedComponentInstances<J>
      : [];
type RequiredResolvedInjectElement<T> = T extends ComponentType
  ? [ResolvedComponentInstance<T>]
  : T extends TargetInject<infer J>
    ? OptionalResolvedComponentInstances<J>
    : T extends DownInject<infer J>
      ? OptionalResolvedComponentInstances<J>
      : [];
export type MaybeResolvedInjectTuple<
  J extends FanInjectTuple,
  R extends ComponentType[],
> = J extends readonly [infer First, ...infer Rest extends FanInjectTuple]
  ? [...MaybeResolvedInjectElement<First, R>, ...MaybeResolvedInjectTuple<Rest, R>]
  : [];
export type RequiredResolvedInjectTuple<J extends InjectTuple> = J extends readonly [
  infer First,
  ...infer Rest extends InjectTuple,
]
  ? [...RequiredResolvedInjectElement<First>, ...RequiredResolvedInjectTuple<Rest>]
  : [];

function _isTargetInject(value: FanInjectElement): value is TargetInject {
  return typeof value === "object" && value !== null && "target" in value;
}

function _isDownInject(value: FanInjectElement): value is DownInject {
  return typeof value === "object" && value !== null && "down" in value;
}

export function mapInject(world: World, inject: readonly FanInjectElement[]): ResolvedInjectTerm[] {
  return inject.map((term) => {
    if (_isTargetInject(term)) {
      return {
        target: [
          _resolveRelationship(term.target[0], world),
          term.target[1].map((C) => world.entity(C).eid),
        ],
      };
    }
    if (_isDownInject(term)) {
      return {
        down: [
          _resolveRelationship(term.down[0], world),
          term.down[1].map((C) => world.entity(C).eid),
        ],
      };
    }
    return world.entity(term).eid;
  });
}

export function injectArity(inject: readonly ResolvedInjectTerm[]): number {
  let arity = 0;
  inject.forEach((term) => {
    arity +=
      typeof term === "number" ? 1 : "target" in term ? term.target[1].length : term.down[1].length;
  });
  return arity;
}

export function getInjected(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  requireDirectComponents: boolean,
  out: (ComponentInstance | undefined)[],
  exitSnapshot?: Map<number, ComponentInstance>
): void {
  let outIndex = 0;
  inject.forEach((term) => {
    if (typeof term === "number") {
      const c = exitSnapshot?.get(term) ?? e._get(term);
      if (requireDirectComponents && !c) {
        throw new Error("query does not contain component");
      }
      out[outIndex++] = c;
      return;
    }
    if ("down" in term) {
      throw new Error("down injection is only supported in each/forEach");
    }
    const targetEntity = e.has(term.target[0])
      ? (e._get(term.target[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.target[1].forEach((componentEid) => {
      out[outIndex++] = targetEntity?.has(componentEid)
        ? targetEntity._get(componentEid)
        : undefined;
    });
  });
}

export function getInjectedWithSrc(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  out: (ComponentInstance | undefined)[],
  src: (Entity | undefined)[],
  requireDirectComponents = false,
  exitSnapshot?: Map<number, ComponentInstance>
): void {
  let outIndex = 0;
  inject.forEach((term) => {
    if (typeof term === "number") {
      const c = exitSnapshot?.get(term) ?? e._get(term);
      if (requireDirectComponents && !c) {
        throw new Error("query does not contain component");
      }
      out[outIndex] = c;
      src[outIndex] = e;
      outIndex++;
      return;
    }
    if ("down" in term) {
      throw new Error("down injection is only supported in each/forEach");
    }
    const targetEntity = e.has(term.target[0])
      ? (e._get(term.target[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.target[1].forEach((componentEid) => {
      out[outIndex] = targetEntity?.has(componentEid) ? targetEntity._get(componentEid) : undefined;
      src[outIndex] = targetEntity;
      outIndex++;
    });
  });
}

export function directInjectEids(inject: readonly ResolvedInjectTerm[]): number[] {
  return inject.filter((term): term is number => typeof term === "number");
}

/**
 * Per-iteration cursor passed to `each` / `forEach` / `enter` / `exit` /
 * `update` / `sort` callbacks when the caller opts in by passing `Iter` as
 * the first argument:
 *
 * ```ts
 * system.each(Iter, [Body, { target: [ChildOf, [Position]] }], (it, [body, pos]) => {
 *   it.entity;  // the visited entity
 *   it.src[0];  // entity `body` was read from (the visited entity)
 *   it.src[1];  // entity `pos` was read from (the ChildOf target), or undefined
 * });
 * ```
 *
 * A single instance is created when the iteration is set up and mutated before
 * every callback, so it allocates nothing per entity. Read what you need inside
 * the callback; do not retain the cursor or its {@link src} array across
 * callbacks.
 */
export class Iter {
  /** The entity currently being visited. */
  public entity!: Entity;

  /**
   * Source entity for each injected component, in the same order as the
   * resolved tuple: the visited entity for a directly-injected component, or
   * the relationship target for a `target`-injected one (`undefined` when the
   * entity has no such relationship or target).
   */
  public readonly src: (Entity | undefined)[];

  constructor(arity: number) {
    this.src = new Array(arity);
  }
}

export function isCursorMarker(x: unknown): x is typeof Entity | typeof Iter {
  return x === Entity || x === Iter;
}

export function wantsIter(x: unknown): x is typeof Iter {
  return x === Iter;
}

/**
 * Iterate `entities`, resolving injected components per the `forEach` /
 * `each` argument grammar (bare callback, `[components]`, `Entity`/`Iter`
 * cursor markers). Runs inside a deferred scope so mutations made by the
 * callback are buffered and applied after iteration finishes.
 *
 * Shared by {@link Query.forEach} and {@link Group.forEach} so both honour the
 * same injection and deferral semantics.
 */
export function forEachInjected(
  world: World,
  entities: Iterable<Entity>,
  arg0: unknown,
  arg1?: unknown,
  arg2?: unknown
): void {
  world.beginDefer();
  try {
    // Bare `forEach(callback)`: a function that is not a cursor marker.
    if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
      for (const entity of entities) {
        (arg0 as (e: Entity) => void)(entity);
      }
      return;
    }
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly FanInjectElement[];
    const callback = (isCursorMarker(arg0) ? arg2 : arg1) as (
      eOrIt: unknown,
      resolved: unknown
    ) => void;
    const invoke = makeInjectedInvoker(world, components, useIter, callback);
    for (const entity of entities) {
      invoke(entity);
    }
  } finally {
    world.endDefer();
  }
}

export function makeInjectedInvoker(
  world: World,
  components: readonly FanInjectElement[],
  useIter: boolean,
  callback: (eOrIt: unknown, resolved: unknown) => void
): (e: Entity) => void {
  const inject = mapInject(world, components);
  const arity = injectArity(inject);
  const resolved = new Array(arity);
  const down = _findSingleDownInject(inject);
  if (down !== undefined) {
    if (useIter) {
      const it = new Iter(arity);
      return (e: Entity) => {
        const children = e._childrenByEid(down.relEid);
        if (children === undefined) {
          return;
        }
        it.entity = e;
        getInjectedWithSrcSkippingDown(e, inject, resolved, it.src);
        children.forEach((child) => {
          fillDownInject(child, down.componentEids, down.slot, resolved, it.src);
          callback(it, resolved);
        });
      };
    }
    return (e: Entity) => {
      const children = e._childrenByEid(down.relEid);
      if (children === undefined) {
        return;
      }
      getInjectedSkippingDown(e, inject, resolved);
      children.forEach((child) => {
        fillDownInject(child, down.componentEids, down.slot, resolved);
        callback(e, resolved);
      });
    };
  }
  if (useIter) {
    const it = new Iter(arity);
    return (e: Entity) => {
      it.entity = e;
      getInjectedWithSrc(e, inject, resolved, it.src);
      callback(it, resolved);
    };
  }
  return (e: Entity) => {
    getInjected(e, inject, false, resolved);
    callback(e, resolved);
  };
}

function _findSingleDownInject(
  inject: readonly ResolvedInjectTerm[]
): { relEid: number; componentEids: readonly number[]; slot: number } | undefined {
  let found: { relEid: number; componentEids: readonly number[]; slot: number } | undefined;
  let slot = 0;
  inject.forEach((term) => {
    if (typeof term === "number") {
      slot++;
      return;
    }
    if ("target" in term) {
      slot += term.target[1].length;
      return;
    }
    if (found !== undefined) {
      throw new Error("Only one down injection is supported per tuple");
    }
    found = { relEid: term.down[0], componentEids: term.down[1], slot };
    slot += term.down[1].length;
  });
  return found;
}

function fillDownInject(
  child: Entity,
  componentEids: readonly number[],
  slot: number,
  out: (ComponentInstance | undefined)[],
  src?: (Entity | undefined)[]
): void {
  componentEids.forEach((componentEid, offset) => {
    const outIndex = slot + offset;
    out[outIndex] = child.has(componentEid) ? child._get(componentEid) : undefined;
    if (src) {
      src[outIndex] = child;
    }
  });
}

function getInjectedSkippingDown(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  out: (ComponentInstance | undefined)[]
): void {
  let outIndex = 0;
  inject.forEach((term) => {
    if (typeof term === "number") {
      out[outIndex++] = e._get(term);
      return;
    }
    if ("down" in term) {
      outIndex += term.down[1].length;
      return;
    }
    const targetEntity = e.has(term.target[0])
      ? (e._get(term.target[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.target[1].forEach((componentEid) => {
      out[outIndex++] = targetEntity?.has(componentEid)
        ? targetEntity._get(componentEid)
        : undefined;
    });
  });
}

function getInjectedWithSrcSkippingDown(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  out: (ComponentInstance | undefined)[],
  src: (Entity | undefined)[]
): void {
  let outIndex = 0;
  inject.forEach((term) => {
    if (typeof term === "number") {
      out[outIndex] = e._get(term);
      src[outIndex] = e;
      outIndex++;
      return;
    }
    if ("down" in term) {
      outIndex += term.down[1].length;
      return;
    }
    const targetEntity = e.has(term.target[0])
      ? (e._get(term.target[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.target[1].forEach((componentEid) => {
      out[outIndex] = targetEntity?.has(componentEid) ? targetEntity._get(componentEid) : undefined;
      src[outIndex] = targetEntity;
      outIndex++;
    });
  });
}
