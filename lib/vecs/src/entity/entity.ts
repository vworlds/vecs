import { type ComponentType } from "../component_meta.js";
import { ChildOf } from "../modules/relationship_types.js";
import { type World } from "../world/index.js";
import { IdentityEntity } from "./entity.identity.js";

/** Entity id assigned by a {@link World}. */
export type EID = number;

export type EntityClass<T extends Entity = Entity> = new (
  world: World,
  eid: EID,
  ownComponentClass?: ComponentType
) => T;

/**
 * A game object: a unique numeric id with an arbitrary set of
 * {@link ComponentInstance | components} attached.
 *
 * Never instantiate `Entity` directly. Use {@link World.entity} for an
 * auto-assigned id, or {@link World.getOrCreateEntity} when the id comes from
 * an external authority such as a game server:
 *
 * ```ts
 * const e = world.entity();
 * e.set(Position, { x: 100 });
 * ```
 *
 * ## Deferred semantics
 *
 * Inside a system body or `forEach` iteration the world is in **deferred
 * mode**: `add` / `attach` / `set` / `ensure` / `modified` / `remove` /
 * `destroy` only enqueue commands. The data layer (the components map and
 * `componentBitmask`) is mutated when the world drains its queue. Concretely,
 * while deferred:
 *
 * - `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.add(C)` (no instance yet).
 * - `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.attach(instance)` if C was absent.
 * - `entity.get(C)` / `entity.getMut(C)` returns the previous value after `entity.set(C, props)`.
 * - `entity.ensure(C)` returns a mutable component immediately, but `entity.get(C)` does not see it until the queue drains.
 * - `entity.get(C)` / `entity.getMut(C)` still returns the component after `entity.remove(C)`.
 *
 * Outside deferred mode the same calls execute inline and mutations are
 * visible immediately.
 */
export class Entity extends IdentityEntity {
  /** Attach this entity to `parent` through the built-in `ChildOf` relationship. */
  public childOf(parent: Entity): this {
    return this.add(ChildOf, parent);
  }

  /** Get this entity's parent through the built-in `ChildOf` relationship, if present. */
  public get parent(): Entity | undefined {
    return this.target(ChildOf);
  }

  /** Set this entity's parent through the built-in `ChildOf` relationship. */
  public set parent(parent: Entity | undefined) {
    if (parent === undefined) {
      this.remove(ChildOf);
    } else {
      this.childOf(parent);
    }
  }

  /** True if this entity has been destroyed (marked for deletion). */
  public get destroyed(): boolean {
    return this._destroyed;
  }

  /** True if this entity is alive (not destroyed). */
  public get alive(): boolean {
    return !this._destroyed;
  }

  /**
   * Return a diagnostic summary for JSON and assertion/snapshot formatting.
   * Live entities include component class names, never component data. Destroyed
   * entities include `destroyed: true` instead of a component list.
   * This is not a persistence format or a never-reused identity.
   */
  public toJSON(): {
    entity: EID;
    name: string | undefined;
    components?: string[];
    destroyed?: true;
  } {
    if (this.destroyed) {
      return { entity: this.eid, name: this.name, destroyed: true };
    }
    const components: string[] = [];
    this.components.forEach((_value, eid) => {
      components.push(this.world.entity(eid).meta.Class.name);
    });
    return { entity: this.eid, name: this.name, components };
  }
}
