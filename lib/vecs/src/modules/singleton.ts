import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";

export class Singleton {}

export class SingletonModule extends Module {
  public init(): void {
    this.world.component(Singleton);
    this.world.hook(Singleton).onAdd((target) => this._registerSingleton(target));
  }

  private _registerSingleton(target: Entity): void {
    const targetMeta = this.world.getComponentMeta(target);
    if (targetMeta.usageCount !== 0) {
      throw new Error(
        `Cannot make component ${targetMeta.Class.name} singleton; ${targetMeta.usageCount} instance(s) already exist`
      );
    }

    targetMeta.onAdd((entity) => {
      if (entity !== target || targetMeta.usageCount !== 1) {
        throw new Error(
          `Cannot add singleton component ${targetMeta.Class.name} to entity ${entity.eid}; singleton instance is entity ${target.eid}`
        );
      }
    });
    target.add(target);
  }
}
