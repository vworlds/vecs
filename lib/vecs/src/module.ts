import { Component } from "./component.js";

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
export abstract class Module extends Component {
  /**
   * Initialise this module.
   *
   * Called once by the world after the module entity has been created and
   * registered. Implementations should register components, attach hooks, and
   * perform any other world-level setup required by the module.
   */
  public abstract init(): void;
}
