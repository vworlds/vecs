import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";

/**
 * World-pinned leaf term that matches every entity carrying a specific
 * component type.
 *
 * `ComponentTerm` is the component-presence index. It maintains the live set
 * of entities that have the component identified by `componentEid`. The world
 * routes `add`, `remove`, and `set`/`modified` commands here via the
 * `notifyComponent*` helpers in `build.ts`.
 *
 * - **Membership** events (`componentAdded` / `componentRemoved`) propagate
 *   via the standard `_add`/`_delete` path and fan out to all consumers as
 *   enter/exit events.
 * - **Data-only** changes (`componentChanged`) emit only a refresh hint via
 *   `_emitRefresh`, which wakes predicate terms watching this component
 *   without triggering a membership re-evaluation in terms that do not care
 *   about component values.
 */
export class ComponentTerm extends Term {
  public constructor(
    world: World,
    key: string,
    public readonly componentEid: EID,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "component", true, onDestroy);
    this._initializeFromWorld();
  }

  /** Called by `build.ts` when the component is added to `entity`. */
  public componentAdded(entity: Entity): void {
    this._add(entity);
  }

  /**
   * Called by `build.ts` when the component's value changes on `entity`
   * without a membership change.
   *
   * Emits a refresh hint rather than an enter/exit event so that consumers
   * watching for data updates (predicate terms) are woken while
   * membership-only consumers are not disturbed.
   */
  public componentChanged(entity: Entity): void {
    this._emitRefresh(entity);
  }

  /** Called by `build.ts` when the component is removed from `entity`. */
  public componentRemoved(entity: Entity): void {
    this._delete(entity);
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return entity.alive && entity._get(this.componentEid) !== undefined;
  }
}
