import { type ComponentClass } from "../component.js";
import { Entity, type EID, type EntityClass } from "../entity/index.js";
import { Components } from "./world.components.js";
import type { World } from "./world.js";

type ModuleEntity = Entity & { init(): void };

export class Modules extends Components {
  public module<T extends ModuleEntity>(this: World, ModuleClass: EntityClass<T>, eid?: EID): T {
    const ComponentClass = ModuleClass as unknown as ComponentClass;
    const isNew = !this._classRegistry.has(ComponentClass);
    const mod = this._component<T>(ModuleClass, ComponentClass, eid, this._modulePool);
    if (isNew) {
      mod.init();
    }
    return mod;
  }
}
