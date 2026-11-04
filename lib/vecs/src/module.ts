import type { Entity } from "./entity/index.js";
import type { World } from "./world/index.js";

export type ModuleConfig<T extends Module<any>> = T extends Module<infer Config> ? Config : never;

/** A concrete {@link Module} subclass, as passed to {@link World.module}. */
export type ModuleClass<T extends Module<any> = Module<any>> = new (
  world: World,
  entity: Entity
) => T;

/**
 * Base class for world modules.
 *
 * A `Module` is a plain object, not an entity, that {@link World.module}
 * creates once per world and initialises through its {@link init} method
 * (registering components, setting up hooks, creating systems, etc.).
 *
 * User code does not instantiate `Module` subclasses directly; the world
 * registers the class as a component type, constructs the module with its
 * {@link world} and definition {@link entity}, stores the module as the
 * class's `Singleton` value on that entity and runs `init`:
 * `world.get(MyModule)` returns that same module. Module values are never
 * captured by subtree snapshots. Release resources acquired in {@link init}
 * through `this.entity.on("remove", ...)` or a static
 * `vecs_remove(entity, mod)` hook. {@link World.dispose} removes module values
 * in reverse installation order after application cleanup and before
 * infrastructure destruction.
 *
 * The definition entity is for module scope and hooks, not gameplay data:
 * every entity shares the per-entity write paths, so keep game state on game
 * entities or singleton components.
 */
export abstract class Module<Config extends object | undefined = undefined> {
  declare protected readonly moduleConfig?: Config;

  /**
   * @param world - The world installing this module.
   * @param entity - The module class's definition entity in `world`.
   */
  public constructor(
    /** The world that installed this module. */
    public readonly world: World,
    /**
     * The module class's definition entity. Entities created during
     * {@link init} are `ChildOf` it; register module hooks on it.
     */
    public readonly entity: Entity
  ) {}

  /**
   * Initialise this module.
   *
   * Called once by the world after the module has been created and stored on
   * its definition entity. Implementations should register components, attach
   * hooks, and perform any other world-level setup required by the module.
   */
  public abstract init(config: Config): void;
}

/** @internal Whether `entity` is the definition entity of a module class. */
export function _isModuleDefinition(entity: Entity): boolean {
  return entity.isComponent && entity.meta.Class.prototype instanceof Module;
}
