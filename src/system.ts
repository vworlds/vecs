import { ArrayMap } from "./util/array_map.js";
import { Bitset } from "./util/bitset.js";
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
type RunCallback = (now: number, delta: number) => void;

/** A function that tests whether a given entity belongs to a system. */
export type EntityTestFunc = (e: Entity) => boolean;

type ComponentOrParent = typeof Component | { parent: typeof Component };
type ComponentOrParentType = number | { parent: number };

type ComponentInstance<T> = T extends { parent: typeof Component }
  ? InstanceType<T["parent"]>
  : T extends typeof Component
  ? InstanceType<T>
  : never;

/**
 * A composable query expression used to declare which entities a
 * {@link System} should track.
 *
 * Queries can be nested arbitrarily:
 *
 * ```ts
 * // Entities that have Position AND (Sprite OR Container):
 * world.system("render").query({
 *   AND: [Position, { OR: [Sprite, Container] }]
 * });
 *
 * // Entities that have a parent with Player AND Container:
 * world.system("attach").query({
 *   PARENT: { AND: [Player, Container] }
 * });
 * ```
 *
 * Short forms:
 * - A single class or type id is equivalent to `{ HAS: [C] }`.
 * - An array `[A, B]` is equivalent to `{ HAS: [A, B] }`.
 * - Pass an {@link EntityTestFunc} directly for fully custom membership logic.
 */
export type SystemQuery =
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

/**
 * A reactive processor that operates on a filtered subset of world entities.
 *
 * Systems are created and registered through {@link World.system}:
 *
 * ```ts
 * world.system("Move")
 *   .requires(Position, Velocity)       // track entities with both components
 *   .phase("update")
 *   .enter([Position], (e, [pos]) => { pos.x = 0; })
 *   .update(Position, (pos) => { pos.x += pos.vx; })
 *   .exit((e) => { console.log("entity left", e.eid); });
 * ```
 *
 * All builder methods return `this` for chaining. Call {@link World.start}
 * once all systems are registered; after that, drive the loop with
 * {@link World.runPhase}.
 *
 * ### Component injection
 *
 * `enter`, `exit`, and `update` support *injection*: pass an array of
 * component classes as the first argument and they will be resolved from the
 * entity and passed as a typed tuple to the callback. Use
 * `{ parent: SomeComponent }` to resolve from the entity's parent instead of
 * the entity itself.
 */
export class System {
  protected componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  protected eachCallback: EntityCallback | undefined;
  protected entities = new Set<Entity>();
  protected _enterCallback: EntityCallback[] = [];
  protected _exitCallback: EntityCallback[] = [];
  private _runCallback: RunCallback | undefined;
  protected _belongs: EntityTestFunc = (e: Entity) => false;
  private readonly updateQueue: (Component | undefined)[] = [];
  private hasQuery = false;
  /** @internal */
  public _phase: string | Phase | undefined;

  protected watchlistBitmask: Bitset = new Bitset();

  constructor(
    /** Unique name for this system, used in logs and pipeline output. */
    public readonly name: string,
    /** The world that owns this system. */
    public readonly world: World
  ) {}

  /** Returns the system name. */
  public toString(): string {
    return this.name;
  }

  /**
   * Assign this system to a pipeline phase.
   *
   * The phase can be specified by name (the world will resolve it at
   * {@link World.start | start} time) or by an {@link IPhase} reference
   * returned from {@link World.addPhase}. Systems without an explicit phase
   * are placed in the built-in `"update"` phase.
   *
   * @param p - Phase name or `IPhase` reference.
   * @returns `this` for chaining.
   */
  public phase(p: string | IPhase) {
    if (typeof p !== "string") {
      if (!(p instanceof Phase)) throw "Invalid Phase object";
      if (p.world !== this.world)
        throw "Phase does not belong to this system's world";
    }
    this._phase = p;
    return this;
  }

  /** @internal Delivers a component-modified notification to this system. */
  public notifyModified(c: Component) {
    if (!this.watchlistBitmask.hasBit(c.bitPtr)) return;
    this.updateQueue.push(c);
  }

  /** Returns `true` if the entity satisfies this system's query. */
  public belongs(e: Entity): boolean {
    return this._belongs(e);
  }

  /** @internal Fires `enter` callbacks for a newly matched entity. */
  public _enter(e: Entity) {
    this._enterCallback.forEach((callback) => callback(e));
    e.forEachComponent((c) => this.notifyModified(c));
    if (this.eachCallback) this.entities.add(e);
  }

  /** @internal Fires `exit` callbacks when an entity leaves the system. */
  public _exit(e: Entity) {
    this._exitCallback.forEach((callback) => callback(e));
    this.entities.delete(e);
    // remove queued updates for components of the exiting entity:
    this.updateQueue.forEach((c, i) => {
      if (!c) return;
      if (c.entity === e) this.updateQueue[i] = undefined;
    });
  }

  /** @internal Execute one tick: run `run`, fire `each`, then drain the update queue. */
  public _run(now: number, delta: number) {
    if (this._runCallback) this._runCallback(now, delta);

    if (this.eachCallback) {
      const cb = this.eachCallback;
      this.entities.forEach((e) => cb(e));
    }

    this.updateQueue.forEach((c) => {
      if (!c) return;
      const callback = this.componentUpdateCallbacks.get(c.type);
      if (callback) {
        callback(c);
      }
    });
    this.updateQueue.length = 0;
  }

  private getComponent(
    e: Entity,
    C: ComponentOrParentType,
    considerDeleted: boolean
  ) {
    let c: Component | undefined;
    if (typeof C === "number") {
      c = e.get(C, considerDeleted); // obtain an instance of C
    } else {
      c = e.parent && e.parent.get(C.parent, considerDeleted);
    }
    return c;
  }

  private getInjected(
    e: Entity,
    inject: ComponentOrParentType[],
    considerDeleted = false
  ) {
    const injected: Component[] = [];
    inject.forEach((C) => {
      const c = this.getComponent(e, C, considerDeleted);
      if (!c) throw "system does not contain component";
      injected.push(c);
    });
    return injected;
  }

  private mapInjectedClassToTypes<J extends ComponentOrParent[]>(
    inject: readonly [...J]
  ): ComponentOrParentType[] {
    //map injected class constructors to type numbers which are faster to search for later
    return inject.map((C) => {
      if (typeof C === "function") return this.world.getComponentType(C);
      return { parent: this.world.getComponentType(C.parent) };
    });
  }

  /**
   * Register a callback that fires when an entity **enters** this system
   * (i.e. first satisfies the system's query) with injected components.
   *
   * @param inject - Ordered list of component classes (or `{ parent: C }`) to
   *   resolve from the entering entity and pass to `callback`.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * system.enter([Position, Sprite], (e, [pos, sprite]) => {
   *   sprite.initialize(scene);
   *   sprite.sprite.setPosition(pos.x, pos.y);
   * });
   * ```
   */
  public enter<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;

  /**
   * Register a callback that fires when an entity enters this system.
   *
   * @param callback - Receives only the entity (no injection).
   * @returns `this` for chaining.
   */
  public enter(callback: (e: Entity) => void): System;

  // Implement the overloaded function
  public enter<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System {
    if (typeof injectOrCallback === "function") {
      // It is the second signature
      this._enterCallback.push(injectOrCallback);
    } else {
      // It is the first signature
      const inject = this.mapInjectedClassToTypes(injectOrCallback);
      this._enterCallback.push((e: Entity) => {
        callback!(e, this.getInjected(e, inject) as any);
      });
    }
    return this;
  }

  /**
   * Register a callback that fires when an entity **exits** this system
   * (its components no longer satisfy the query, or it was destroyed) with
   * injected components.
   *
   * Components that were just removed are still accessible via `get_deleted`
   * semantics — the injected tuple includes them even though they are no
   * longer in the entity's active component set.
   *
   * @param inject - Component classes to resolve and inject.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns `this` for chaining.
   */
  public exit<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;

  /**
   * Register a callback that fires when an entity exits this system.
   *
   * @param callback - Receives only the entity.
   * @returns `this` for chaining.
   */
  public exit(callback: (e: Entity) => void): System;

  // Implement the overloaded function
  public exit<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System {
    if (typeof injectOrCallback === "function") {
      // It is the second signature
      this._exitCallback.push(injectOrCallback);
    } else {
      // It is the first signature
      const inject = this.mapInjectedClassToTypes(injectOrCallback);
      this._exitCallback.push((e: Entity) => {
        callback!(e, this.getInjected(e, inject, true) as any);
      });
    }
    return this;
  }

  /**
   * Register a per-tick callback that runs every time this system's phase
   * executes, regardless of entity membership.
   *
   * Use this for logic that is not driven by component updates — polling,
   * network flushing, global timers, etc.
   *
   * @param callback - Receives `now` (absolute timestamp in ms) and `delta`
   *   (ms since the last tick).
   * @returns `this` for chaining.
   */
  public run(callback: RunCallback): System {
    this._runCallback = callback;
    return this;
  }

  /**
   * Register a callback that fires when a component of type `ComponentClass`
   * is modified on any entity in this system.
   *
   * The system will automatically begin tracking entities that have this
   * component type (equivalent to adding it to a `requires` / `HAS` query)
   * unless a custom {@link query} was already set.
   *
   * @param ComponentClass - The component class to watch.
   * @param callback - Receives the modified component instance.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("RenderPosition")
   *   .update(Position, (pos) => {
   *     sprite.setPosition(pos.x, pos.y);
   *   });
   * ```
   */
  public update<C extends typeof Component>(
    ComponentClass: C,
    callback: (c: InstanceType<C>) => void
  ): System;

  /**
   * Register a callback that fires when `ComponentClass` is modified, with
   * additional components injected from the same entity.
   *
   * @param ComponentClass - The component class to watch.
   * @param inject - Additional component classes to resolve from the entity.
   * @param callback - Receives the modified component and the injected tuple.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("SyncSprite")
   *   .update(Position, [Sprite], (pos, [sprite]) => {
   *     sprite.sprite.setPosition(pos.x, pos.y);
   *   });
   * ```
   */
  update<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): System;

  update<C extends typeof Component, J extends (typeof Component)[]>(
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
      //map injected class constructors to component type numbers which are faster to search for later
      const injectedComponentTypes = inject.map((C) =>
        this.world.getComponentType(C)
      );
      const cb = (c: Component) => {
        const injected: any[] = [];
        injectedComponentTypes.forEach((InjectedComponentType) => {
          injected.push(c.entity.get(InjectedComponentType));
        });

        if (callback) {
          callback(c as InstanceType<C>, injected as any);
        }
      };

      this.componentUpdateCallbacks.set(type, cb);
    }

    this.watchlistBitmask.add(type);

    if (!this.hasQuery) {
      const watchlist: number[] = this.watchlistBitmask.indices();
      this._belongs = HAS(this.world, ...watchlist);
    }

    return this;
  }

  /**
   * Register a callback that fires **every tick** for every entity currently
   * tracked by this system, with the listed components resolved from each
   * entity.
   *
   * Unlike {@link update} (which only fires when `component.modified()` is
   * called), `each` fires unconditionally on every tick the system runs,
   * once per tracked entity. Components missing from an entity appear as
   * `undefined` in the resolved tuple.
   *
   * `each` does **not** modify the system's query — define membership with
   * {@link requires} or {@link query} as usual.
   *
   * Only a single `each` callback may be registered per system; calling
   * `each` a second time throws.
   *
   * @param components - Component classes to resolve from each entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances (or `undefined` for any component the entity lacks).
   * @returns `this` for chaining.
   * @throws If `each` has already been registered on this system.
   *
   * @example
   * ```ts
   * world.system("Move")
   *   .requires(Position, Velocity)
   *   .each([Position, Velocity], (e, [pos, vel]) => {
   *     pos.x += vel.vx;
   *     pos.y += vel.vy;
   *   });
   * ```
   */
  public each<J extends (typeof Component)[]>(
    components: readonly [...J],
    callback: (
      e: Entity,
      resolved: { [K in keyof J]: InstanceType<J[K]> | undefined }
    ) => void
  ): System {
    if (this.eachCallback) {
      throw `each already registered for system '${this.name}'`;
    }
    const types = components.map((C) => this.world.getComponentType(C));
    this.eachCallback = (e: Entity) => {
      const resolved = types.map((t) => e.get(t));
      callback(e, resolved as any);
    };
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

  /**
   * Set the entity membership predicate using the {@link SystemQuery} DSL.
   *
   * Replaces any implicit query derived from `update` watchlists and any
   * previous `requires` call. After calling `query`, auto-expanding of
   * `update` watchlists is disabled.
   *
   * @param q - A {@link SystemQuery} expression.
   * @returns `this` for chaining.
   */
  public query(q: SystemQuery) {
    this._belongs = this.queryBuilder(q);
    this.hasQuery = true;
    return this;
  }

  /**
   * Shorthand for `query([...components])` — the system tracks entities that
   * have **all** of the listed component types.
   *
   * Equivalent to `query({ HAS: components })`.
   *
   * @param components - One or more component classes or type ids.
   * @returns `this` for chaining.
   */
  public requires(...components: ComponentClassArray) {
    this.query(components);
    return this;
  }
}
