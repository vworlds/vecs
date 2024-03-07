import { ArrayMap } from "../../util/array_map.js";
import { Bitset } from "../../util/bitset.js";
import {
  Component,
  ComponentClassArray,
  ComponentClassOrType,
  calculateComponentBitmask,
} from "./component.js";
import type { Entity } from "./entity.js";
import { Phase, type IPhase } from "./phase.js";
import { type World } from "./world.js";

type EntityCallback = (e: Entity) => void;
type ComponentCallback = (c: Component) => void;
type OnRunCallback = (now: number, delta: number) => void;
export type EntityTestFunc = (e: Entity) => boolean;

export type SystemDependency = number | string | symbol | typeof Component;

type ComponentOrParent = typeof Component | { parent: typeof Component };
type ComponentInstance<T> = T extends { parent: typeof Component }
  ? InstanceType<T["parent"]>
  : T extends typeof Component
  ? InstanceType<T>
  : never;

type SystemQuery =
  | ComponentClassArray
  | ComponentClassOrType
  | EntityTestFunc
  | { HAS: ComponentClassArray | ComponentClassOrType }
  | { HAS_ONLY: ComponentClassArray | ComponentClassOrType }
  | { AND: SystemQuery[] }
  | { OR: SystemQuery[] }
  | { NOT: SystemQuery }
  | { PARENT: SystemQuery };

function HAS(world: World, ...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.hasBitset(testBitmask);
}

function HAS_ONLY(
  world: World,
  ...components: ComponentClassArray
): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.equal(testBitmask);
}

function NOT(func: EntityTestFunc): EntityTestFunc {
  return (e: Entity) => !func(e);
}

function AND(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.every((f) => f(e));
}

function OR(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.some((f) => f(e));
}

function PARENT(func: EntityTestFunc) {
  return (e: Entity) => (e.parent && func(e.parent)) || false;
}

export class System {
  protected componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  protected _onEnter: EntityCallback[] = [];
  protected _onExit: EntityCallback[] = [];
  private _onRun: OnRunCallback | undefined;
  protected _belongs: EntityTestFunc = (e: Entity) => false;
  private readonly updateQueue: (Component | undefined)[] = [];
  private _writes: SystemDependency[] = [];
  protected _reads: SystemDependency[] = [];
  private hasQuery = false;
  public _phase: string | Phase | undefined;

  protected watchlistBitmask: Bitset = new Bitset();
  constructor(public readonly name: string, public readonly world: World) {}

  public toString(): string {
    return this.name;
  }

  public phase(p: string | IPhase) {
    if (typeof p !== "string") {
      if (!(p instanceof Phase)) throw "Invalid Phase object";
      if (p.world !== this.world)
        throw "Phase does not belong to this system's world";
    }
    this._phase = p;
    return this;
  }

  public writes(...w: SystemDependency[]) {
    this._writes.push(...w);
    return this;
  }
  public reads(...r: SystemDependency[]) {
    this._reads.push(...r);
    return this;
  }

  public getWrites() {
    return this._writes;
  }
  public getReads() {
    return this._reads;
  }

  public notifyModified(c: Component) {
    if (!this.watchlistBitmask.hasBit(c.bitPtr)) return;
    this.updateQueue.push(c);
  }

  public belongs(e: Entity): boolean {
    return this._belongs(e);
  }

  public enter(e: Entity) {
    this._onEnter.forEach((callback) => callback(e));
    e.forEachComponent((c) => this.notifyModified(c));
  }
  public exit(e: Entity) {
    this._onExit.forEach((callback) => callback(e));
    // remove queued updates for components of the exiting entity:
    this.updateQueue.forEach((c, i) => {
      if (!c) return;
      if (c.entity === e) this.updateQueue[i] = undefined;
    });
  }
  public run(now: number, delta: number) {
    if (this._onRun) this._onRun(now, delta);

    this.updateQueue.forEach((c) => {
      if (!c) return;
      const callback = this.componentUpdateCallbacks.get(c.type);
      if (callback) {
        callback(c);
      }
    });
    this.updateQueue.length = 0;
  }

  private getComponent<Class extends ComponentOrParent>(
    e: Entity,
    C: Class,
    considerDeleted: boolean
  ) {
    let c: Component | undefined;
    if (typeof C === "function") {
      c = e.get(C, considerDeleted); // obtain an instance of C
    } else {
      // parent: C was used, so we ask the parent for an instance of C.parent
      c = e.parent && e.parent.get(C.parent, considerDeleted);
    }
    return c;
  }

  private getInjected<J extends ComponentOrParent[]>(
    e: Entity,
    inject: readonly [...J],
    considerDeleted = false
  ) {
    const injected = [] as { [K in keyof J]: ComponentInstance<J[K]> };
    inject.forEach((C) => {
      const c = this.getComponent(e, C, considerDeleted);
      if (!c) throw "system does not contain component";
      injected.push(c);
    });
    return injected;
  }

  public onEnter<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;
  public onEnter(callback: (e: Entity) => void): System;

  // Implement the overloaded function
  public onEnter<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System {
    if (typeof injectOrCallback === "function") {
      // It is the second signature
      this._onEnter.push(injectOrCallback);
    } else {
      // It is the first signature
      this._onEnter.push((e: Entity) => {
        const inject = injectOrCallback;
        callback!(e, this.getInjected(e, inject));
      });
    }
    return this;
  }

  public onExit<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;
  public onExit(callback: (e: Entity) => void): System;

  // Implement the overloaded function
  public onExit<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System {
    if (typeof injectOrCallback === "function") {
      // It is the second signature
      this._onExit.push(injectOrCallback);
    } else {
      // It is the first signature
      this._onExit.push((e: Entity) => {
        const inject = injectOrCallback;
        callback!(e, this.getInjected(e, inject, true));
      });
    }
    return this;
  }

  public onRun(callback: OnRunCallback) {
    this._onRun = callback;
  }

  public onUpdate<C extends typeof Component>(
    ComponentClass: C,
    callback: (c: InstanceType<C>) => void
  ): System;

  onUpdate<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;

  onUpdate<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    injectOrCallback: readonly [...J] | ((c: InstanceType<C>) => void),
    callback?: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System {
    const type = this.world.getComponentType(ComponentClass);
    if (typeof injectOrCallback === "function") {
      // Only ComponentClass and callback are passed
      callback = injectOrCallback;
      this.componentUpdateCallbacks.set(type, callback as any);
    } else {
      // ComponentClass, inject, and callback are passed
      const inject = injectOrCallback;
      const cb = (c: Component) => {
        const injected: any[] = [];
        inject.forEach((InjectedComponent) => {
          injected.push(c.entity.get(InjectedComponent));
        });

        if (callback) {
          callback(c as InstanceType<C>, injected as any);
        }
      };

      this.componentUpdateCallbacks.set(type, cb);
    }

    this.watchlistBitmask.add(type);
    this._reads.push(ComponentClass);

    if (!this.hasQuery) {
      const watchlist: number[] = this.watchlistBitmask.indices();
      this._belongs = HAS(this.world, ...watchlist);
    }

    return this;
  }

  private queryBuilder(q: SystemQuery): EntityTestFunc {
    if (
      typeof q === "number" ||
      (typeof q === "function" && q.prototype instanceof Component)
    ) {
      return HAS(this.world, q as typeof Component);
    } else if (typeof q === "function") {
      return q as EntityTestFunc;
    }

    if (q instanceof Array) {
      return HAS(this.world, ...q);
    }

    if ("HAS" in q) {
      return this.queryBuilder(q.HAS);
    }

    if ("HAS_ONLY" in q) {
      const v = q.HAS_ONLY;
      if (v instanceof Array) {
        return HAS_ONLY(this.world, ...v);
      }
      return HAS_ONLY(this.world, v);
    }

    if ("AND" in q) {
      return AND(...q.AND.map((sq) => this.queryBuilder(sq)));
    }

    if ("OR" in q) {
      return OR(...q.OR.map((sq) => this.queryBuilder(sq)));
    }

    if ("NOT" in q) {
      return NOT(this.queryBuilder(q.NOT));
    }

    if ("PARENT" in q) {
      return PARENT(this.queryBuilder(q.PARENT));
    }
    throw "Unrecognized query term";
  }

  public query(q: SystemQuery) {
    this._belongs = this.queryBuilder(q);
    this.hasQuery = true;
    return this;
  }

  public requires(...components: ComponentClassArray) {
    this.query(components);
    return this;
  }
}
