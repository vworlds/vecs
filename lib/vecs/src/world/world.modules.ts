import { type ComponentClass } from "../component.js";
import { type EID, type EntityClass } from "../entity/index.js";
import { type Module, type ModuleConfig } from "../module.js";
import { Components } from "./world.components.js";
import type { World } from "./world.js";

type ModuleArgs<T extends Module<any>> =
  undefined extends ModuleConfig<T>
    ? [eid?: EID] | [config: Exclude<ModuleConfig<T>, undefined>, eid?: EID]
    : [config: ModuleConfig<T>, eid?: EID];

export class Modules extends Components {
  /** @internal Constructor-installed core modules predate scoped ChildOf support. */
  protected _initializingModules = false;

  /**
   * Install a module once and run its synchronous init inside its entity scope.
   * Constructor-installed core modules are unscoped; later modules parent all
   * newly created entities, including nested modules. Existing entities stay put.
   * Subsequent calls return the existing instance; passing config again throws.
   */
  public module<T extends Module<any>>(
    this: World,
    ModuleClass: EntityClass<T>,
    ...args: ModuleArgs<T>
  ): T {
    const { config, eid } = resolveModuleArgs(args as [eid?: EID] | [config: object, eid?: EID]);
    const ComponentClass = ModuleClass as unknown as ComponentClass;
    const isNew = !this._classRegistry.has(ComponentClass);
    const mod = this._component<T>(ModuleClass, ComponentClass, eid, this._modulePool);
    if (!isNew && config !== undefined) {
      throw new Error(
        `Module ${ModuleClass.name} is already registered; configuration is only accepted on first registration`
      );
    }
    if (isNew) {
      if (this._initializingModules) {
        mod.init(config as ModuleConfig<T>);
      } else {
        this.scope(mod, () => mod.init(config as ModuleConfig<T>));
      }
    }
    return mod;
  }
}

function resolveModuleArgs(args: [eid?: EID] | [config: object, eid?: EID]): {
  config: object | undefined;
  eid: EID | undefined;
} {
  const first = args[0];
  if (typeof first === "number") {
    return { config: undefined, eid: first };
  }
  return { config: first, eid: args[1] };
}
