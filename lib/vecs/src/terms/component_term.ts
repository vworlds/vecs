import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, TermEventKind } from "./term.js";

/**
 * World-pinned leaf term that matches every entity carrying a specific
 * component type.
 *
 * `ComponentTerm` delegates component-presence storage to the current
 * `ComponentMeta` for `componentEid`. The world routes `add`, `remove`, and
 * `set`/`modified` commands here via the `notifyComponent*` helpers in
 * `build.ts`.
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
  }

  public override get count(): number {
    return this._meta()?._getLiveCount() ?? 0;
  }

  public override [Symbol.iterator](): IterableIterator<Entity> {
    return this._meta()?._liveCarriers() ?? [][Symbol.iterator]();
  }

  public override has(entity: Entity): boolean {
    return this._meta()?._isLive(entity) ?? false;
  }

  /** Called by `build.ts` when the component is added to `entity`. */
  public componentAdded(entity: Entity): void {
    if (this.has(entity)) {
      this._emit(TermEventKind.Enter, entity);
    }
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
    if (!this.has(entity)) {
      this._emit(TermEventKind.Exit, entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return entity.alive && this.has(entity);
  }

  private _meta() {
    return this.world.getEntity(this.componentEid)?.meta;
  }
}
