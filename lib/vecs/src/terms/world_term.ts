import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, type TermConsumer } from "./term.js";

/**
 * World-pinned leaf term that matches every live entity.
 *
 * `WorldTerm` is the "universe" node: it holds all entities that are not
 * destroyed. Component-definition entities are first-class members too (they
 * are ordinary entities), so world-rooted queries can enumerate them — this is
 * what makes schema reflection possible. Every other term that needs
 * world-lifecycle awareness (e.g. `NotTerm`, `PredicateTerm`) subscribes to
 * this leaf via the standard membership channel so they see entity creation
 * and destruction.
 *
 * ## Shape channel
 *
 * `WorldTerm` also maintains a separate **shape channel** via
 * {@link subscribeShape} / {@link entityShapeChanged}. When a component is
 * added to or removed from an entity, `build.ts` calls
 * `entityShapeChanged`; the world term then fans that notification out to all
 * registered shape consumers as an `onTermRefresh` call. Only terms that are
 * sensitive to the *set* of components on an entity (currently `OnlyTerm` and
 * merged `PredicateTerm` nodes that contain an `only(...)` sub-expression)
 * register on this channel, keeping it zero-cost for the common case.
 */
export class WorldTerm extends Term {
  /**
   * @internal Consumers registered via {@link subscribeShape} that want
   * notification when any entity's component set changes.
   */
  private readonly _shapeConsumers = new Set<TermConsumer>();

  public constructor(world: World, key: string, onDestroy: (term: Term) => void) {
    super(world, key, "world", true, onDestroy);
    this._initializeFromWorld();
  }

  /**
   * Called by `build.ts` when a new entity is created.
   *
   * Adds the entity if it matches (i.e. it is live), which propagates an enter
   * event to all consumers.
   */
  public entityCreated(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    }
  }

  /**
   * Called by `build.ts` when an entity is destroyed.
   *
   * Unconditionally removes the entity, propagating an exit event.
   */
  public entityDestroyed(entity: Entity): void {
    this._delete(entity);
  }

  /**
   * Called by `build.ts` when a component is added to or removed from an
   * entity (a shape change).
   *
   * Notifies all {@link _shapeConsumers} via `onTermRefresh` so terms like
   * `OnlyTerm` can re-evaluate whether the entity's component set still
   * satisfies their exact-match predicate.
   *
   * Only fires for entities already in this term's set (i.e. live entities) —
   * there is no point notifying about shape changes on entities that the world
   * term itself does not track.
   */
  public entityShapeChanged(entity: Entity): void {
    if (!this.has(entity)) {
      return;
    }
    for (const consumer of [...this._shapeConsumers]) {
      consumer.onTermRefresh?.(entity);
    }
  }

  /**
   * Register `consumer` on the shape channel and return an unsubscribe
   * function.
   *
   * The shape channel is separate from the standard membership channel so
   * that component-add/remove events can be distinguished from
   * entity-create/destroy events. Consumers on this channel receive
   * `onTermRefresh` calls (not `onTermEvent`) because the shape change does
   * not itself imply a membership change in the world term.
   *
   * @param consumer - The term or callback object to notify.
   * @returns Cleanup function; safe to call multiple times.
   */
  public subscribeShape(consumer: TermConsumer): () => void {
    this._shapeConsumers.add(consumer);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this._shapeConsumers.delete(consumer);
    };
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return entity.alive;
  }
}
