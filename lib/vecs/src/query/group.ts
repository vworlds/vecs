import { type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectTuple,
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
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<J extends FanInjectTuple>(
    options: EntityCursorOption & FanInjectCallbackOptions<J>,
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<J extends FanInjectTuple>(
    options: IterCursorOption & FanInjectCallbackOptions<J>,
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach(arg0: unknown, arg1?: unknown): this {
    forEachInjected(this._world, this._entities, arg0, arg1);
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
