import { type ComponentInstance, type ComponentRef, type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import { type World } from "./world/index.js";
import { _resolveRelationship, type MaybeRequired } from "./dsl.js";

export type UpInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  up: readonly [ComponentRef, readonly [...J]];
};
export type DownInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  down: readonly [ComponentRef, readonly [...J]];
};
export type InjectElement = ComponentType | UpInject;
export type FanInjectElement = InjectElement | DownInject;
export type InjectTuple = readonly InjectElement[];
export type FanInjectTuple = readonly FanInjectElement[];
export type ResolvedInjectTerm =
  | number
  | { up: readonly [number, readonly number[]] }
  | { down: readonly [number, readonly number[]] };

/** Resolves the component instance type for one injected component class. */
type ResolvedComponentInstance<T> = T extends ComponentType ? InstanceType<T> : never;
type OptionalResolvedComponentInstances<J extends readonly ComponentType[]> = {
  [K in keyof J]: InstanceType<J[K]> | undefined;
};
type MaybeResolvedFanInjectElement<T, R extends ComponentType[]> = T extends ComponentType
  ? [MaybeRequired<T, R>]
  : T extends UpInject<infer J>
    ? OptionalResolvedComponentInstances<J>
    : T extends DownInject<infer J>
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
  ? [...MaybeResolvedFanInjectElement<First, R>, ...MaybeResolvedInjectTuple<Rest, R>]
  : [];
/** Fan-out version — `DownInject` resolved as nullable per-child slots. */
export type MaybeResolvedFanInjectTuple<
  J extends FanInjectTuple,
  R extends ComponentType[],
> = J extends readonly [infer First, ...infer Rest extends FanInjectTuple]
  ? [...MaybeResolvedFanInjectElement<First, R>, ...MaybeResolvedFanInjectTuple<Rest, R>]
  : [];
export type RequiredResolvedInjectTuple<J extends InjectTuple> = J extends readonly [
  infer First,
  ...infer Rest extends InjectTuple,
]
  ? [...RequiredResolvedInjectElement<First>, ...RequiredResolvedInjectTuple<Rest>]
  : [];

function _isUpInject(value: FanInjectElement): value is UpInject {
  return typeof value === "object" && value !== null && "up" in value;
}

function _isDownInject(value: FanInjectElement): value is DownInject {
  return typeof value === "object" && value !== null && "down" in value;
}

export function mapInject(world: World, inject: FanInjectTuple): ResolvedInjectTerm[] {
  return inject.map((term) => {
    if (_isUpInject(term)) {
      return {
        up: [_resolveRelationship(term.up[0], world), term.up[1].map((C) => world.entity(C).eid)],
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
    if (typeof term === "number") {
      arity += 1;
    } else if ("down" in term) {
      arity += term.down[1].length;
    } else {
      arity += term.up[1].length;
    }
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
    if ("up" in term) {
      const target = e.componentBitmask.has(term.up[0])
        ? (e._get(term.up[0]) as { target?: Entity } | undefined)?.target
        : undefined;
      term.up[1].forEach((componentEid) => {
        out[outIndex++] = target?.componentBitmask.has(componentEid)
          ? target._get(componentEid)
          : undefined;
      });
    }
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
    if ("up" in term) {
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
    }
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
  components: readonly FanInjectElement[],
  useIter: boolean,
  callback: (eOrIt: unknown, resolved: unknown) => void
): (e: Entity) => void {
  const inject = mapInject(world, components);
  const arity = injectArity(inject);

  const downTerm = inject.find(
    (t): t is { down: readonly [number, readonly number[]] } => typeof t !== "number" && "down" in t
  );

  const downCount = inject.filter((t) => typeof t !== "number" && "down" in t).length;
  if (downCount > 1) {
    throw new Error("At most one `down` injection term is allowed per tuple");
  }

  if (!downTerm) {
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

  const [downRelEid, downCompEids] = downTerm.down;
  const downFirstSlot = injectArity(inject.slice(0, inject.indexOf(downTerm)));
  const downSlotCount = downCompEids.length;

  const nonDownTerms = inject.filter((t) => !(typeof t !== "number" && "down" in t));
  const nonDownArity = injectArity(nonDownTerms);

  const resolved = new Array(arity);

  if (useIter) {
    const it = new Iter(arity);
    return (e: Entity) => {
      getInjectedWithSrc(e, nonDownTerms, resolved, it.src);
      const children = e._childrenByEid(downRelEid);
      if (!children || children.size === 0) {
        return;
      }
      for (const child of children) {
        for (let i = 0; i < downSlotCount; i++) {
          const compEid = downCompEids[i];
          const outIdx = downFirstSlot + i;
          resolved[outIdx] = child.componentBitmask.has(compEid) ? child._get(compEid) : undefined;
          it.src[outIdx] = child;
        }
        it.entity = e;
        callback(it, resolved);
      }
    };
  }
  return (e: Entity) => {
    getInjected(e, nonDownTerms, false, resolved);
    const children = e._childrenByEid(downRelEid);
    if (!children || children.size === 0) {
      return;
    }
    for (const child of children) {
      for (let i = 0; i < downSlotCount; i++) {
        const compEid = downCompEids[i];
        const outIdx = downFirstSlot + i;
        resolved[outIdx] = child.componentBitmask.has(compEid) ? child._get(compEid) : undefined;
      }
      callback(e, resolved);
    }
  };
}
