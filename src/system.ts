import { ArrayMap } from "../../util/array_map.js";
import { Bitset } from "../../util/bitset.js";
import {
  Component,
  ComponentClassArray,
  ComponentClassOrType,
  calculateComponentBitmask,
} from "./component.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

type EntityCallback = (e: Entity) => void;
type ComponentCallback = (c: Component) => void;
export type EntityTestFunc = (e: Entity) => boolean;

export type SystemDependency = number | string | symbol | typeof Component;

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

const defaultBelongsFunc: EntityTestFunc = (e: Entity) => false;

export abstract class SystemBase {
  protected callbacks = new ArrayMap<ComponentCallback>();
  protected _onEnter: EntityCallback[] = [];
  protected _onExit: EntityCallback[] = [];
  protected _belongs: EntityTestFunc = defaultBelongsFunc;
  private readonly updateQueue: (Component | undefined)[] = [];
  private _writes: SystemDependency[] = [];
  protected _reads: SystemDependency[] = [];

  protected watchlistBitmask: Bitset = new Bitset();
  constructor(public readonly name: string, public readonly world: World) {}

  public toString(): string {
    return this.name;
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
  public run() {
    this.updateQueue.forEach((c) => {
      if (!c) return;
      const callback = this.callbacks.get(c.type);
      if (callback) {
        callback(c);
      }
    });
    this.updateQueue.length = 0;
  }
}

type ComponentOrParent = typeof Component | { parent: typeof Component };
type ComponentInstance<T> = T extends { parent: typeof Component }
  ? InstanceType<T["parent"]>
  : T extends typeof Component
  ? InstanceType<T>
  : never;

export class System<S extends (typeof Component)[] = []> extends SystemBase {
  constructor(name: string, world: World) {
    super(name, world);
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
  ): System<S>;
  public onEnter(callback: (e: Entity) => void): System<S>;

  // Implement the overloaded function
  public onEnter<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System<S> {
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
  ): System<S>;
  public onExit(callback: (e: Entity) => void): System<S>;

  // Implement the overloaded function
  public onExit<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System<S> {
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

  public onUpdate<C extends S[number]>(
    ComponentClass: C,
    callback: (c: InstanceType<C>) => void
  ): System<S>;

  onUpdate<C extends S[number], J extends (typeof Component)[]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System<S>;

  onUpdate<C extends S[number], J extends (typeof Component)[]>(
    ComponentClass: C,
    injectOrCallback: readonly [...J] | ((c: InstanceType<C>) => void),
    callback?: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System<S> {
    if (typeof injectOrCallback === "function") {
      // Only ComponentClass and callback are passed
      callback = injectOrCallback;
      this.callbacks.set(
        this.world.getComponentType(ComponentClass),
        callback as any
      );
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

      this.callbacks.set(this.world.getComponentType(ComponentClass), cb);
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
    return this;
  }

  public requires(...components: ComponentClassArray) {
    this.query(components);
    return this;
  }
  public watch<S extends (typeof Component)[] = []>(
    ...componentWatchlist: readonly [...S]
  ): System<S> {
    this.watchlistBitmask = calculateComponentBitmask(
      componentWatchlist as any as ComponentClassArray,
      this.world
    );
    if (this._belongs == defaultBelongsFunc) {
      this._belongs = HAS(this.world, ...componentWatchlist);
    }
    this._reads.push(...componentWatchlist);
    return this;
  }
}
