import { ModuleDef } from "../component_def.js";
import { type EID } from "../entity/index.js";
import { type Module, type ModuleClass, type ModuleConfig } from "../module.js";
import { Singleton } from "../modules/singleton.js";
import { Components } from "./world.components.js";
import type { World } from "./world.js";

type ModuleArgs<T extends Module<any>> =
  undefined extends ModuleConfig<T>
    ? [eid?: EID] | [config: Exclude<ModuleConfig<T>, undefined>, eid?: EID]
    : [config: ModuleConfig<T>, eid?: EID];

export class Modules extends Components {
  /** @internal Constructor-installed core modules predate scoped ChildOf support. */
  protected _initializingModules = false;
  /** @internal Core modules installed while their trait installers bootstrap. */
  protected readonly _coreModules: Module<any>[] = [];

  /**
   * Install a module once and run its synchronous init inside its entity scope.
   * Registers `ModuleClass` as a component type in the module id pool, creates
   * the module with its world and definition entity, tags that entity with
   * `ModuleDef`, stores the module as the class's Singleton value on it (read
   * with world.get/has) and runs init.
   * Constructor-installed core modules are unscoped; later modules parent all
   * newly created entities, including nested modules, to `mod.entity`.
   * Existing entities stay put.
   * Subsequent calls return the existing instance; passing config again throws.
   * New installations throw while deferred; call outside progress() and defer.
   * Existing-instance lookups remain available while deferred.
   * Module values are never captured by snapshots. Release a module's resources
   * with a remove hook on its entity or a static vecs_remove; dispose removes
   * module values after application cleanup, in reverse install order.
   *
   * @returns The module instance, which is not an entity.
   * @throws When `ModuleClass` is registered but has no module value: it was
   *   registered with {@link component} only, or its value was removed.
   */
  public module<T extends Module<any>>(
    this: World,
    ModuleClass: ModuleClass<T>,
    ...args: ModuleArgs<T>
  ): T {
    const { config, eid } = resolveModuleArgs(args as [eid?: EID] | [config: object, eid?: EID]);
    const isNew = !this._classRegistry.has(ModuleClass);
    if (isNew && this.deferred) {
      throw new Error("Call world.module() outside progress() and defer to install a new module");
    }
    const entity = this._component(ModuleClass, eid, this._modulePool);
    if (!isNew) {
      if (config !== undefined) {
        throw new Error(
          `Module ${ModuleClass.name} is already registered; configuration is only accepted on first registration`
        );
      }
      const existing = entity.get(ModuleClass);
      if (existing === undefined) {
        throw new Error(`Module ${ModuleClass.name} is registered but not installed`);
      }
      return existing;
    }
    const mod = new ModuleClass(this, entity);
    if (this._initializingModules) {
      this._coreModules.push(mod);
      mod.init(config as ModuleConfig<T>);
    } else {
      this._installModuleSingleton(mod);
      this.scope(entity, () => mod.init(config as ModuleConfig<T>));
    }
    return mod;
  }

  /**
   * @internal Tag the definition with `ModuleDef` and store the module as its
   * Singleton value. Core modules are prepared after their trait installers
   * have bootstrapped.
   */
  protected _installModuleSingleton(mod: Module<any>): void {
    mod.entity.add(mod.world.component(ModuleDef)).add(Singleton).attach(mod);
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
