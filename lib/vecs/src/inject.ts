import {
  type ComponentInstance,
  type ComponentRef,
  type ComponentType,
  type Relationship,
} from "./component.js";
import { Entity, RESERVED_EID as TARGET_ENTITY, type EID } from "./entity/index.js";
import { type World } from "./world/index.js";
import { _resolveRelationship, type MaybeRequired } from "./dsl.js";

// Injection uses the reserved id to keep target projection arrays numeric and SMI-friendly.

/** Inject the processing system tick's absolute timestamp in milliseconds. System callbacks only. */
export const Now: unique symbol = Symbol("Now");
/** Inject the system's accumulated tick delta in milliseconds, matching `run`. System callbacks only. */
export const Delta: unique symbol = Symbol("Delta");
/** System-only inject tokens; each resolves to a non-optional number. */
export type ClockInject = typeof Now | typeof Delta;
/** Component/relationship injects usable outside a system processing tick. */
export type ComponentInjectElement = ComponentType | TargetInject | TargetsInject;
export type ComponentInjectTuple = readonly ComponentInjectElement[];
/** Synchronous inject tuple, including child fan-out but excluding processing clocks. */
export type ComponentFanInjectTuple = readonly (ComponentInjectElement | DownInject)[];

/** @internal Stable clock fields on every System, written once per processing tick. */
export type InjectClock = { readonly _injectNow: number; readonly _injectDelta: number };

export type TargetInjectProjection = ComponentType | typeof Entity;

/**
 * Follows a relationship and injects values from its target into a callback tuple.
 *
 * Pass one component class or {@link Entity} directly for a single slot, or pass
 * a tuple to project several slots in order:
 *
 * ```ts
 * { target: [FriendOf, Position] }          // Position | undefined
 * { target: [FriendOf, Entity] }            // Entity | undefined
 * { target: [FriendOf, [Entity, Position]] } // Entity | undefined, Position | undefined
 * ```
 *
 * Every projected slot is optional because the relationship or target-side
 * component may be absent when the callback runs.
 */
export type TargetInject<
  P extends TargetInjectProjection | readonly TargetInjectProjection[] =
    TargetInjectProjection | readonly TargetInjectProjection[],
> = {
  target: readonly [ComponentRef, P];
};
/**
 * Follows every target of a relationship and injects one array-valued tuple slot.
 * Each array entry is a projected tuple for one target, in relationship order.
 */
export type TargetsInject<
  P extends TargetInjectProjection | readonly TargetInjectProjection[] =
    TargetInjectProjection | readonly TargetInjectProjection[],
> = {
  targets: readonly [ComponentRef, P];
};
export type DownInject<J extends readonly ComponentType[] = readonly ComponentType[]> = {
  down: readonly [ComponentRef, readonly [...J]];
};
/** One direct/relationship inject or a system-only clock token. */
export type InjectElement = ComponentInjectElement | ClockInject;
export type InjectTuple = readonly InjectElement[];
/** An inject element with child fan-out support for each/forEach. Clocks require system each. */
export type FanInjectElement = InjectElement | DownInject;
export type FanInjectTuple = readonly FanInjectElement[];
export type ResolvedInjectTerm =
  | EID
  | { target: readonly [EID, readonly EID[]] }
  | { targets: readonly [EID, readonly EID[]] }
  | { down: readonly [EID, readonly EID[]] };

/** Resolves the component instance type for one injected component class. */
type ResolvedComponentInstance<T> = T extends ComponentType ? InstanceType<T> : never;
type OptionalResolvedComponentInstances<J extends readonly ComponentType[]> = {
  [K in keyof J]: InstanceType<J[K]> | undefined;
};
type OptionalResolvedTargetProjection<P> = P extends typeof Entity
  ? Entity | undefined
  : P extends ComponentType
    ? InstanceType<P> | undefined
    : never;
type OptionalResolvedTargetProjections<P> = P extends readonly TargetInjectProjection[]
  ? { [K in keyof P]: OptionalResolvedTargetProjection<P[K]> }
  : [OptionalResolvedTargetProjection<P>];
type ResolvedTargetsProjection<P> = P extends typeof Entity
  ? Entity
  : P extends ComponentType
    ? InstanceType<P> | undefined
    : never;
/** One projected row produced by a {@link TargetsInject}. */
export type ResolvedTargetsRow<P> = P extends readonly TargetInjectProjection[]
  ? { readonly [K in keyof P]: ResolvedTargetsProjection<P[K]> }
  : readonly [ResolvedTargetsProjection<P>];
/** The single array-valued callback slot produced by a {@link TargetsInject}. */
export type ResolvedTargets<P> = ReadonlyArray<ResolvedTargetsRow<P>>;
export type InjectedValue =
  | number
  | ComponentInstance
  | Entity
  | ReadonlyArray<readonly (ComponentInstance | Entity | undefined)[]>
  | undefined;
export type InjectSource = Entity | readonly Entity[] | undefined;
export type InjectSnapshot = {
  readonly values: readonly InjectedValue[];
  readonly src: readonly InjectSource[];
};
type MaybeResolvedInjectElement<T, R extends ComponentType[]> = T extends ClockInject
  ? [number]
  : T extends ComponentType
    ? [MaybeRequired<T, R>]
    : T extends TargetInject<infer P>
      ? OptionalResolvedTargetProjections<P>
      : T extends TargetsInject<infer P>
        ? [ResolvedTargets<P>]
        : T extends DownInject<infer J>
          ? OptionalResolvedComponentInstances<J>
          : [];
type RequiredResolvedInjectElement<T> = T extends ClockInject
  ? [number]
  : T extends ComponentType
    ? [ResolvedComponentInstance<T>]
    : T extends TargetInject<infer P>
      ? OptionalResolvedTargetProjections<P>
      : T extends TargetsInject<infer P>
        ? [ResolvedTargets<P>]
        : T extends DownInject<infer J>
          ? OptionalResolvedComponentInstances<J>
          : [];
/** Flatten projected slots; components follow query guarantees, clocks are always numbers. */
export type MaybeResolvedInjectTuple<
  J extends FanInjectTuple,
  R extends ComponentType[],
> = J extends readonly [infer First, ...infer Rest extends FanInjectTuple]
  ? [...MaybeResolvedInjectElement<First, R>, ...MaybeResolvedInjectTuple<Rest, R>]
  : [];
/** Entry/exit tuple: require direct components and resolve clocks as non-optional numbers. */
export type RequiredResolvedInjectTuple<J extends InjectTuple> = J extends readonly [
  infer First,
  ...infer Rest extends InjectTuple,
]
  ? [...RequiredResolvedInjectElement<First>, ...RequiredResolvedInjectTuple<Rest>]
  : [];

function _isTargetInject(value: FanInjectElement): value is TargetInject {
  return typeof value === "object" && value !== null && "target" in value;
}

function _isTargetsInject(value: FanInjectElement): value is TargetsInject {
  return typeof value === "object" && value !== null && "targets" in value;
}

function _isDownInject(value: FanInjectElement): value is DownInject {
  return typeof value === "object" && value !== null && "down" in value;
}

function _isTargetProjectionArray(
  value: TargetInjectProjection | readonly TargetInjectProjection[]
): value is readonly TargetInjectProjection[] {
  return Array.isArray(value);
}

function _resolveTargetProjection(
  target: Entity | undefined,
  projection: EID
): ComponentInstance | undefined {
  if (projection === TARGET_ENTITY) {
    return target;
  }
  return target?.has(projection) ? target._get(projection) : undefined;
}

function _resolveTargetsProjection(targets: readonly Entity[], projections: readonly EID[]) {
  return targets.map((target) =>
    projections.map((projection) => _resolveTargetProjection(target, projection))
  );
}

export function mapInject(world: World, inject: readonly FanInjectElement[]): ResolvedInjectTerm[] {
  return inject.map((term) => {
    if (term === Now || term === Delta) {
      throw new Error(
        "Now and Delta injection is only supported in system each/enter/exit/update callbacks"
      );
    }
    if (_isTargetInject(term)) {
      const projection = term.target[1];
      const projections: readonly TargetInjectProjection[] = _isTargetProjectionArray(projection)
        ? projection
        : [projection];
      return {
        target: [
          _resolveRelationship(term.target[0], world),
          projections.map((C) => (C === Entity ? TARGET_ENTITY : world.entity(C).eid)),
        ],
      };
    }
    if (_isTargetsInject(term)) {
      const projection = term.targets[1];
      const projections: readonly TargetInjectProjection[] = _isTargetProjectionArray(projection)
        ? projection
        : [projection];
      return {
        targets: [
          _resolveRelationship(term.targets[0], world),
          projections.map((C) => (C === Entity ? TARGET_ENTITY : world.entity(C).eid)),
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
      typeof term === "number"
        ? 1
        : "target" in term
          ? term.target[1].length
          : "targets" in term
            ? 1
            : term.down[1].length;
  });
  return arity;
}

export function getInjected(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  requireDirectComponents: boolean,
  out: InjectedValue[]
): void {
  _resolveInjected(e, inject, out, undefined, requireDirectComponents, false);
}

export function getInjectedWithSrc(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  out: InjectedValue[],
  src: InjectSource[],
  requireDirectComponents = false
): void {
  _resolveInjected(e, inject, out, src, requireDirectComponents, false);
}

/**
 * Core live-injection resolver shared by every resolution path.
 *
 * Writes one resolved value per tuple slot into `out` and, when `src` is
 * given, the entity (or target array) each value was read from. `down` terms
 * throw unless `skipDown` is set, in which case their slots are skipped for
 * `fillDownInject` to populate per child.
 */
function _resolveInjected(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  out: InjectedValue[],
  src: InjectSource[] | undefined,
  requireDirectComponents: boolean,
  skipDown: boolean
): void {
  let outIndex = 0;
  for (const term of inject) {
    if (typeof term === "number") {
      const c = e._get(term);
      if (requireDirectComponents && !c) {
        throw new Error("query does not contain component");
      }
      out[outIndex] = c;
      if (src !== undefined) {
        src[outIndex] = e;
      }
      outIndex++;
      continue;
    }
    if ("down" in term) {
      if (!skipDown) {
        throw new Error("down injection is only supported in each/forEach");
      }
      outIndex += term.down[1].length;
      continue;
    }
    if ("targets" in term) {
      const targets = e.targets(term.targets[0]);
      out[outIndex] = _resolveTargetsProjection(targets, term.targets[1]);
      if (src !== undefined) {
        src[outIndex] = targets;
      }
      outIndex++;
      continue;
    }
    const targetEntity = e.target(term.target[0]);
    for (const projection of term.target[1]) {
      out[outIndex] = _resolveTargetProjection(targetEntity, projection);
      if (src !== undefined) {
        src[outIndex] = targetEntity;
      }
      outIndex++;
    }
  }
}

/** Capture a detached injection tuple and its source tuple for deferred callback replay. */
export function snapshotInjected(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  arity: number
): InjectSnapshot {
  const values = new Array<InjectedValue>(arity);
  const src = new Array<InjectSource>(arity);
  _snapshotInjectedRaw(e, inject, values, src);
  return { values, src };
}

export function replayInjectedSnapshot(
  inject: readonly ResolvedInjectTerm[],
  snapshot: InjectSnapshot,
  requireDirectComponents: boolean,
  out: InjectedValue[]
): void {
  _validateRequiredDirectInjects(inject, snapshot.values, requireDirectComponents);
  _copySnapshot(snapshot.values, out);
}

export function replayInjectedSnapshotWithSrc(
  inject: readonly ResolvedInjectTerm[],
  snapshot: InjectSnapshot,
  requireDirectComponents: boolean,
  out: InjectedValue[],
  src: InjectSource[]
): void {
  replayInjectedSnapshot(inject, snapshot, requireDirectComponents, out);
  _copySnapshot(snapshot.src, src);
}

/**
 * Component eids whose changes can alter a resolved tuple: directly injected
 * component eids plus the relationship eid of every `target` / `targets` term.
 * Callers watch these to re-sort or re-key when a tuple input changes.
 */
export function injectWatchEids(inject: readonly ResolvedInjectTerm[]): EID[] {
  return inject.flatMap((term) =>
    typeof term === "number"
      ? [term]
      : "target" in term
        ? [term.target[0]]
        : "targets" in term
          ? [term.targets[0]]
          : []
  );
}

/**
 * Per-iteration cursor passed to `each` / `forEach` / `enter` / `exit` /
 * `update` / `orderBy` callbacks when the caller opts in by passing `Iter` as
 * the first argument:
 *
 * ```ts
 * system.each({ cursor: Iter, inject: [Body, { target: [ChildOf, [Position]] }] }, (it, [body, pos]) => {
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
   * resolved tuple: the visited entity for a directly-injected component, the
   * relationship target for a `target`-injected one, the target array for a
   * `targets`-injected one, or the specific child for
   * a `down`-injected one (`undefined` when the entity has no such relationship,
   * target, or — for `down` — when the slot is unfilled).
   */
  public readonly src: InjectSource[];

  constructor(arity: number) {
    this.src = new Array(arity);
  }
}

export function wantsIter(x: unknown): x is typeof Iter {
  return x === Iter;
}

export type FanInjectCallbackOptions<J extends FanInjectTuple = FanInjectTuple> = {
  cursor?: typeof Entity | typeof Iter;
  inject: readonly [...J];
};

export type FanInjectCallbackArg<J extends FanInjectTuple = FanInjectTuple> =
  readonly [...J] | FanInjectCallbackOptions<J>;

export type InjectedCallback = (eOrIt: Entity | Iter, resolved: readonly InjectedValue[]) => void;

/**
 * Iterate `entities`, resolving injected components per the `forEach` /
 * `each` argument grammar (bare callback, `[components]`, or
 * `{ cursor, inject }`). Runs inside a deferred scope so mutations made by the
 * callback are buffered and applied after iteration finishes.
 *
 * Shared by {@link Query.forEach} and {@link Group.forEach} so both honour the
 * same injection and deferral semantics.
 */
export function forEachInjected(
  world: World,
  entities: Iterable<Entity>,
  callbackOrInject: ((e: Entity) => void) | FanInjectCallbackArg,
  injectedCallback?: InjectedCallback
): void {
  world.beginDefer();
  try {
    // Bare `forEach(callback)`: a function that is not a cursor marker.
    if (typeof callbackOrInject === "function") {
      for (const entity of entities) {
        callbackOrInject(entity);
      }
      return;
    }
    const { components, useIter } = normalizeFanInjectCallbackArgs(callbackOrInject);
    const callback = injectedCallback as InjectedCallback;
    const invoke = makeInjectedInvoker(world, components, useIter, callback);
    for (const entity of entities) {
      invoke(entity);
    }
  } finally {
    world.endDefer();
  }
}

export function normalizeFanInjectCallbackArgs(callbackOrInject: FanInjectCallbackArg): {
  components: readonly FanInjectElement[];
  useIter: boolean;
} {
  if (!Array.isArray(callbackOrInject) && "inject" in callbackOrInject) {
    return {
      components: callbackOrInject.inject,
      useIter: wantsIter(callbackOrInject.cursor),
    };
  }
  return { components: callbackOrInject, useIter: false };
}

export function makeInjectedInvoker(
  world: World,
  components: readonly FanInjectElement[],
  useIter: boolean,
  callback: InjectedCallback,
  clock?: InjectClock
): (e: Entity) => void {
  const specialized = specializeClockInject(world, components, useIter, callback, clock, "entity");
  components = specialized.components;
  callback = specialized.callback as InjectedCallback;
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
        _resolveInjected(e, inject, resolved, it.src, false, true);
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
      _resolveInjected(e, inject, resolved, undefined, false, true);
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

/**
 * @internal Strip clocks before any resolver/snapshot/watch-list sees the tuple.
 * Only clock callbacks copy compact component slots into a full output tuple.
 * Slot maps and clock indices are computed once; no token lookup occurs at replay.
 */
export function specializeClockInject(
  world: World,
  components: readonly FanInjectElement[],
  useIter: boolean,
  callback: Function,
  clock: InjectClock | undefined,
  kind: "entity" | "update" | "snapshot"
): { components: readonly FanInjectElement[]; callback: Function } {
  if (!components.some((term) => term === Now || term === Delta)) {
    return { components, callback };
  }
  if (clock === undefined) {
    throw new Error(
      "Now and Delta injection is only supported in system each/enter/exit/update callbacks"
    );
  }
  const compact: FanInjectElement[] = [];
  const slots: number[] = [];
  const nowSlots: number[] = [];
  const deltaSlots: number[] = [];
  let arity = 0;
  for (const term of components) {
    if (term === Now) {
      nowSlots.push(arity++);
    } else if (term === Delta) {
      deltaSlots.push(arity++);
    } else {
      compact.push(term);
      const width = injectArity(mapInject(world, [term]));
      for (let i = 0; i < width; i++) {
        slots.push(arity++);
      }
    }
  }
  const fill = (values: readonly InjectedValue[], out: InjectedValue[]) => {
    for (let i = 0; i < slots.length; i++) {
      out[slots[i]] = values[i];
    }
    for (let i = 0; i < nowSlots.length; i++) {
      out[nowSlots[i]] = clock._injectNow;
    }
    for (let i = 0; i < deltaSlots.length; i++) {
      out[deltaSlots[i]] = clock._injectDelta;
    }
  };
  const fillCursor = (cursor: Entity | Iter, it: Iter) => {
    const compactIt = cursor as Iter;
    it.entity = compactIt.entity;
    for (let i = 0; i < slots.length; i++) {
      it.src[slots[i]] = compactIt.src[i];
    }
  };
  // Preserve enter/exit's detached tuple/cursor lifetime. each/update reuse theirs.
  if (kind === "snapshot") {
    if (useIter) {
      return {
        components: compact,
        callback: (cursor: Iter, values: readonly InjectedValue[]) => {
          const out = new Array<InjectedValue>(arity);
          const it = new Iter(arity);
          fill(values, out);
          fillCursor(cursor, it);
          callback(it, out);
        },
      };
    }
    return {
      components: compact,
      callback: (e: Entity, values: readonly InjectedValue[]) => {
        const out = new Array<InjectedValue>(arity);
        fill(values, out);
        callback(e, out);
      },
    };
  }
  const out = new Array<InjectedValue>(arity);
  if (useIter) {
    const it = new Iter(arity);
    if (kind === "update") {
      return {
        components: compact,
        callback: (cursor: Iter, c: ComponentInstance, values: readonly InjectedValue[]) => {
          fill(values, out);
          fillCursor(cursor, it);
          callback(it, c, out);
        },
      };
    }
    return {
      components: compact,
      callback: (cursor: Iter, values: readonly InjectedValue[]) => {
        fill(values, out);
        fillCursor(cursor, it);
        callback(it, out);
      },
    };
  }
  if (kind === "update") {
    return {
      components: compact,
      callback: (e: Entity, c: ComponentInstance, values: readonly InjectedValue[]) => {
        fill(values, out);
        callback(e, c, out);
      },
    };
  }
  return {
    components: compact,
    callback: (e: Entity, values: readonly InjectedValue[]) => {
      fill(values, out);
      callback(e, out);
    },
  };
}

function _findSingleDownInject(
  inject: readonly ResolvedInjectTerm[]
): { relEid: EID; componentEids: readonly EID[]; slot: number } | undefined {
  let found: { relEid: EID; componentEids: readonly EID[]; slot: number } | undefined;
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
    if ("targets" in term) {
      slot++;
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
  componentEids: readonly EID[],
  slot: number,
  out: InjectedValue[],
  src?: InjectSource[]
): void {
  componentEids.forEach((componentEid, offset) => {
    const outIndex = slot + offset;
    out[outIndex] = child.has(componentEid) ? child._get(componentEid) : undefined;
    if (src) {
      src[outIndex] = child;
    }
  });
}

function _copySnapshot<T>(snapshot: readonly T[], out: T[]): void {
  for (let index = 0; index < snapshot.length; index++) {
    out[index] = snapshot[index];
  }
}

function _validateRequiredDirectInjects(
  inject: readonly ResolvedInjectTerm[],
  values: readonly InjectedValue[],
  required: boolean
): void {
  if (!required) {
    return;
  }
  let valueIndex = 0;
  for (const term of inject) {
    if (typeof term === "number") {
      if (!values[valueIndex]) {
        throw new Error("query does not contain component");
      }
      valueIndex++;
    } else if ("target" in term) {
      valueIndex += term.target[1].length;
    } else if ("targets" in term) {
      valueIndex++;
    } else {
      valueIndex += term.down[1].length;
    }
  }
}

function _snapshotInjectedRaw(
  e: Entity,
  inject: readonly ResolvedInjectTerm[],
  values: InjectedValue[],
  src: InjectSource[]
): void {
  let valueIndex = 0;
  for (const term of inject) {
    if (typeof term === "number") {
      values[valueIndex] = e._get(term);
      src[valueIndex] = e;
      valueIndex++;
      continue;
    }
    if ("target" in term) {
      const target = (e._get(term.target[0]) as Relationship | undefined)?._target();
      for (const projection of term.target[1]) {
        values[valueIndex] = projection === TARGET_ENTITY ? target : target?._get(projection);
        src[valueIndex] = target;
        valueIndex++;
      }
      continue;
    }
    if ("targets" in term) {
      const targets = (e._get(term.targets[0]) as Relationship | undefined)?._targetArray() ?? [];
      values[valueIndex] = targets.map((target) =>
        term.targets[1].map((projection) =>
          projection === TARGET_ENTITY ? target : target._get(projection)
        )
      );
      src[valueIndex] = targets;
      valueIndex++;
      continue;
    }
    throw new Error("down injection is only supported in each/forEach");
  }
}
