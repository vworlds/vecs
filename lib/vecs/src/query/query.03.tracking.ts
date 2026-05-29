import { type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { Lifecycle } from "./query.02.lifecycle.js";

export class Tracking<R extends ComponentType[] = []> extends Lifecycle<R> {
  public get count(): number {
    if (!this._tracking) {
      return 0;
    }
    return this._entities?.size ?? this.rootTerm?.count ?? 0;
  }

  public has(e: Entity): boolean {
    if (!this._tracking) {
      return false;
    }
    return this._entities?.has(e) ?? this.rootTerm?.has(e) ?? false;
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._matchedEntities()[Symbol.iterator]();
  }

  public track(): this {
    this._assertConfigurable();
    this._tracking = true;
    return this;
  }

  public belongs(e: Entity): boolean {
    return this.rootTerm?.has(e) ?? false;
  }

  public forEach(callback: (e: Entity) => void): void;
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): void {
    forEachInjected(this.world, this._matchedEntities(), arg0, arg1, arg2);
  }
}
