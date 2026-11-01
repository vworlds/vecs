import { Component } from "./component.js";

export type ModuleConfig<T extends Module<any>> = T extends Module<infer Config> ? Config : never;

/**
 * Base class for built-in world modules.
 *
 * A `Module` is a special component entity that is registered by the world at
 * construction time and performs one-time initialisation (registering
 * components, setting up hooks, etc.) via its {@link init} method.
 *
 * User code does not instantiate `Module` subclasses directly; they are
 * created and initialised by the world internally.
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

  /**
   * Release what this module holds outside the world, such as DOM or scene listeners.
   *
   * Optional. {@link World.dispose} calls it once for every installed module that is still
   * alive, in reverse install order, after application entities are destroyed and before the
   * infrastructure pass destroys component, module, query, system and phase entities. Their
   * `remove` hooks therefore run after every module's `dispose`, and the world, its components
   * and module singleton data are still usable here. Resources bound to a component instance
   * still belong in that component's `remove` hook; use this for what no entity carries.
   *
   * A module destroyed before disposal is not called. An error thrown here propagates out of
   * `World.dispose` and leaves the world partial, as a throwing `remove` hook does.
   */
  public dispose?(): void;
}
