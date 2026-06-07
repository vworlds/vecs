import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";
import type { getTerm as GetTermFn } from "./build.js";

/**
 * Composite term that matches entities carrying **exactly** the specified set
 * of component types — no more, no fewer.
 *
 * Internally composed from two children:
 * - `children[0]`: an `AllTerm` (or array shorthand) for the required
 *   components, ensuring every listed component is present.
 * - `children[1]`: the world leaf, ensuring the entity is live and
 *   non-component.
 *
 * `OnlyTerm` additionally subscribes to the **shape channel** of the world
 * term so it is re-evaluated whenever *any* component is added to or removed
 * from the entity — not just when one of the listed components changes
 * membership. This is necessary because `only` requires `entity.components.size
 * === componentEids.length`; adding an unlisted component must evict the entity
 * even though the `AllTerm` child has not changed.
 */
export class OnlyTerm extends Term {
  public constructor(
    world: World,
    key: string,
    allTerm: Term,
    worldTerm: Term,
    private readonly _componentEids: readonly EID[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "only", false, onDestroy);
    this._setChildren([allTerm, worldTerm]);
    if (worldTerm instanceof WorldTerm) {
      this._addChildCleanup(worldTerm.subscribeShape(this));
    }
    this._initializeFromWorld();
  }

  /**
   * Build an `OnlyTerm` for the given component eid list.
   *
   * @param world - Owning world.
   * @param componentEids - Numeric component type ids that must be present and
   *   comprise the entire component set.
   * @param key - Canonical cache key.
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param onDestroy - Called when the last consumer unsubscribes.
   */
  public static build(
    world: World,
    componentEids: readonly EID[],
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): OnlyTerm {
    // Build the inner all-term for the component set, then the world leaf.
    const allTerm = getTerm(world, componentEids as EID[]);
    const worldTerm = getTerm(world, true);
    return new OnlyTerm(world, key, allTerm, worldTerm, componentEids, onDestroy);
  }

  /**
   * Shape-channel entry point: called directly by `WorldTerm` when the entity's
   * component set changes.
   *
   * Overrides the base `onTermRefresh` to ensure a shape change always
   * triggers a re-evaluation, regardless of which child emitted the hint.
   * Without this override the base implementation would also call `_sync`,
   * but the explicit override makes the intent clear and guards against future
   * base-class changes.
   */
  public override onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

  /**
   * @internal React only to world-kind child refreshes.
   *
   * `OnlyTerm` cares about world-shape events (component add/remove) because
   * the component count check in `_matches` can be violated by adding an
   * unlisted component. Component-kind refreshes (data-only value changes) do
   * not affect `only` membership and are intentionally ignored here.
   */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    if (child.kind === "world") {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return (
      this._children[0].has(entity) &&
      this._children[1].has(entity) &&
      entity.components.size === this._componentEids.length
    );
  }
}
