import { type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectCallbackArg,
  type ComponentFanInjectTuple,
  type InjectedCallback,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { type World } from "../world/index.js";
import type { EntityCursorOption, FanInjectCallbackOptions, IterCursorOption } from "./options.js";

export class Group<K = unknown, R extends ComponentType[] = []> {
  public readonly key: K;
  private readonly _entities = new Set<Entity>();
  private readonly _world: World;

  public constructor(world: World, key: K) {
    this._world = world;
    this.key = key;
  }

  public get count(): number {
    return this._entities.size;
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
  }

  public forEach(callback: (e: Entity) => void): this;
  /** Iterate with component/relationship injects; processing-clock tokens require a system callback. */
  public forEach<const J extends ComponentFanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<const J extends ComponentFanInjectTuple>(
    options: EntityCursorOption & FanInjectCallbackOptions<J>,
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<const J extends ComponentFanInjectTuple>(
    options: IterCursorOption & FanInjectCallbackOptions<J>,
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach(arg0: ((e: Entity) => void) | FanInjectCallbackArg, arg1?: Function): this {
    forEachInjected(this._world, this._entities, arg0, arg1 as InjectedCallback);
    return this;
  }

  public has(e: Entity): boolean {
    return this._entities.has(e);
  }

  /** @internal */
  public _add(e: Entity): void {
    this._entities.add(e);
  }

  /** @internal */
  public _remove(e: Entity): boolean {
    this._entities.delete(e);
    return this._entities.size === 0;
  }
}
