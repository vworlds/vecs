import { type ComponentClass } from "../component.js";
import { Entity, type EID, type EntityClass } from "../entity/index.js";
import { IdentityModule } from "../modules/identity.js";
import { SingletonModule } from "../modules/singleton.js";
import { RelationshipsModule } from "../modules/relationships.js";
import { Components } from "./world.components.js";
import type { WorldOptions } from "./world.base.js";
import type { World } from "./world.js";

type ModuleEntity = Entity & { init(): void };

const BUILTIN_MODULES: EntityClass<ModuleEntity>[] = [
  IdentityModule,
  SingletonModule,
  RelationshipsModule,
];

export class Modules extends Components {
  public constructor(options: WorldOptions = {}) {
    super(options);
    const world = this as unknown as World;
    BUILTIN_MODULES.forEach((mod) => world.module(mod));
  }

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
