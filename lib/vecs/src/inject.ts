import { type ComponentInstance, type ComponentRef, type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import { type World } from "./world/index.js";
import { _resolveRelationship, type MaybeRequired } from "./dsl.js";

export type UpInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  up: readonly [ComponentRef, readonly [...J]];
};
export type InjectElement = ComponentType | UpInject;
export type InjectTuple = readonly InjectElement[];
export type ResolvedInjectTerm = number | { up: readonly [number, readonly number[]] };

/** Resolves the component instance type for one injected component class. */
type ResolvedComponentInstance<T> = T extends ComponentType ? InstanceType<T> : never;
type OptionalResolvedComponentInstances<J extends readonly ComponentType[]> = {
  [K in keyof J]: InstanceType<J[K]> | undefined;
};
type MaybeResolvedInjectElement<T, R extends ComponentType[]> = T extends ComponentType
  ? [MaybeRequired<T, R>]
  : T extends UpInject<infer J>
    ? OptionalResolvedComponentInstances<J>
    : [];
type RequiredResolvedInjectElement<T> = T extends ComponentType
  ? [ResolvedComponentInstance<T>]
  : T extends UpInject<infer J>
    ? OptionalResolvedComponentInstances<J>
    : [];
export type MaybeResolvedInjectTuple<
  J extends InjectTuple,
  R extends ComponentType[],
> = J extends readonly [infer First, ...infer Rest extends InjectTuple]
  ? [...MaybeResolvedInjectElement<First, R>, ...MaybeResolvedInjectTuple<Rest, R>]
  : [];
export type RequiredResolvedInjectTuple<J extends InjectTuple> = J extends readonly [
  infer First,
  ...infer Rest extends InjectTuple,
]
  ? [...RequiredResolvedInjectElement<First>, ...RequiredResolvedInjectTuple<Rest>]
  : [];

function _isUpInject(value: InjectElement): value is UpInject {
  return typeof value === "object" && value !== null && "up" in value;
}

export function mapInject(world: World, inject: InjectTuple): ResolvedInjectTerm[] {
  return inject.map((term) => {
    if (_isUpInject(term)) {
      return {
        up: [_resolveRelationship(term.up[0], world), term.up[1].map((C) => world.entity(C).eid)],
      };
    }
    return world.entity(term).eid;
  });
}

export function injectArity(inject: readonly ResolvedInjectTerm[]): number {
  let arity = 0;
  inject.forEach((term) => {
    arity += typeof term === "number" ? 1 : term.up[1].length;
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
        throw "query does not contain component";
      }
      out[outIndex++] = c;
      return;
    }
    const target = e.componentBitmask.has(term.up[0])
      ? (e._get(term.up[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.up[1].forEach((componentEid) => {
      out[outIndex++] = target?.componentBitmask.has(componentEid)
        ? target._get(componentEid)
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
        throw "query does not contain component";
      }
      out[outIndex] = c;
      src[outIndex] = e;
      outIndex++;
      return;
    }
    const target = e.componentBitmask.has(term.up[0])
      ? (e._get(term.up[0]) as { target?: Entity } | undefined)?.target
      : undefined;
    term.up[1].forEach((componentEid) => {
      out[outIndex] = target?.componentBitmask.has(componentEid)
        ? target._get(componentEid)
        : undefined;
      src[outIndex] = target;
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
 * system.each(Iter, [Body, { up: [ChildOf, [Position]] }], (it, [body, pos]) => {
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
   * the relationship target for an `up`-injected one (`undefined` when the
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

export function makeInjectedInvoker(
  world: World,
  components: readonly InjectElement[],
  useIter: boolean,
  callback: (eOrIt: unknown, resolved: unknown) => void
): (e: Entity) => void {
  const inject = mapInject(world, components);
  const arity = injectArity(inject);
  const resolved = new Array(arity);
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
