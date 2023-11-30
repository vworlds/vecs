import { ArrayMap } from "../../util/array_map.js";
import { BitPtr, Bitset } from "../../util/bitset.js";
import {
  Component,
  ComponentClassArray,
  calculateComponentBitmask,
} from "./component.js";
import type { Entity } from "./entity.js";

type EntityCallback = (e: Entity) => void;
type ComponentCallback = (c: Component) => void;
export type EntityTestFunc = (e: Entity) => boolean;

export abstract class SystemBase {
  protected callbacks = new ArrayMap<ComponentCallback>();
  protected _onEnter: EntityCallback[] = [];
  protected _onExit: EntityCallback[] = [];
  protected readonly _belongs: EntityTestFunc | undefined;
  private readonly updateQueue: Component[] = [];

  public readonly watchlistBitmask: Bitset;
  public readonly key: BitPtr;
  public readonly id: number;
  private static keyCounter: number = 0;
  constructor(
    public readonly name: string,
    public readonly componentWatchlist: ComponentClassArray,
    entityTestFunc?: EntityTestFunc
  ) {
    this.watchlistBitmask = calculateComponentBitmask(componentWatchlist);
    this._belongs = entityTestFunc;
    this.id = SystemBase.keyCounter++;
    this.key = new BitPtr(this.id);
  }

  public toString(): string {
    return this.name;
  }

  public notifyModified(c: Component) {
    const C = c.constructor as typeof Component;
    if (!this.watchlistBitmask.hasBit(C.bitPtr)) return;
    this.updateQueue.push(c);
  }

  public belongs(e: Entity): boolean {
    if (this._belongs) return this._belongs(e);
    return e.componentBitmask.hasBitset(this.watchlistBitmask);
  }

  public enter(e: Entity) {
    this._onEnter.forEach((callback) => callback(e));
  }
  public exit(e: Entity) {
    this._onExit.forEach((callback) => callback(e));
  }
  public run() {
    this.updateQueue.forEach((c) => {
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

export class System<S extends (typeof Component)[]> extends SystemBase {
  constructor(
    name: string,
    componentWatchlist: readonly [...S],
    entityTestFunc?: EntityTestFunc
  ) {
    super(
      name,
      componentWatchlist as any as ComponentClassArray,
      entityTestFunc
    );
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

  onUpdate<C extends S[number], J extends S[number][]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: InstanceType<J[K]> }
    ) => void
  ): System<S>;

  onUpdate<C extends S[number], J extends S[number][]>(
    ComponentClass: C,
    injectOrCallback: readonly [...J] | ((c: InstanceType<C>) => void),
    callback?: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: InstanceType<J[K]> }
    ) => void
  ): System<S> {
    if (typeof injectOrCallback === "function") {
      // Only ComponentClass and callback are passed
      callback = injectOrCallback;
      this.callbacks.set(ComponentClass.type, callback as any);
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

      this.callbacks.set(ComponentClass.type, cb);
    }
    return this;
  }
}

export function HAS(...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components);
  return (e: Entity) => e.componentBitmask.hasBitset(testBitmask);
}

export function HAS_ONLY(...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components);
  return (e: Entity) => e.componentBitmask === testBitmask;
}

export function NOT(func: EntityTestFunc): EntityTestFunc {
  return (e: Entity) => !func(e);
}

export function AND(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.every((f) => f(e));
}

export function OR(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.some((f) => f(e));
}

export function PARENT(func: EntityTestFunc) {
  return (e: Entity) => (e.parent && func(e.parent)) || false;
}
