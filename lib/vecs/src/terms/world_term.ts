import { Component } from "../component.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, type TermConsumer } from "./term.js";

export class WorldTerm extends Term {
  private readonly _shapeConsumers = new Set<TermConsumer>();

  public constructor(world: World, key: string, onDestroy: (term: Term) => void) {
    super(world, key, "world", true, onDestroy);
    this._initializeFromWorld();
  }

  public entityCreated(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    }
  }

  public entityDestroyed(entity: Entity): void {
    this._delete(entity);
  }

  public entityShapeChanged(entity: Entity): void {
    if (this.has(entity)) {
      this._shapeConsumers.forEach((consumer) => consumer.onTermRefresh?.(entity));
    }
  }

  public subscribeShape(consumer: TermConsumer): () => void {
    this._shapeConsumers.add(consumer);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this._shapeConsumers.delete(consumer);
    };
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && !(entity instanceof Component);
  }
}
