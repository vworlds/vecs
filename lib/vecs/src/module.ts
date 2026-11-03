import { Component } from "./component.js";

export type ModuleConfig<T extends Module<any>> = T extends Module<infer Config> ? Config : never;

/**
 * Base class for world modules.
 *
 * A `Module` is a special component entity registered by {@link World.module}
 * that performs one-time initialisation (registering
 * components, setting up hooks, etc.) via its {@link init} method.
 *
 * User code does not instantiate `Module` subclasses directly; they are
 * created and initialised by the world internally. It carries itself as its
 * class's `Singleton` value: `world.get(MyModule)` returns that same module.
 * Module values are `DontSnapshot`. Release resources acquired in {@link init}
 * through `on("remove", ...)` or a static `vecs_remove(entity, mod)` hook.
 * {@link World.dispose} removes module values in reverse installation order
 * after application cleanup and before infrastructure destruction.
 */
export abstract class Module<Config extends object | undefined = undefined> extends Component {
  declare protected readonly moduleConfig?: Config;

  /**
   * Initialise this module.
   *
   * Called once by the world after the module entity has been created and
   * registered. Implementations should register components, attach hooks, and
   * perform any other world-level setup required by the module.
   */
  public abstract init(config: Config): void;
}
