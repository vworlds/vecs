import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";

export class ComponentTerm extends Term {
  public constructor(
    world: World,
    key: string,
    public readonly componentEid: number,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "component", true, onDestroy);
    this._initializeFromWorld();
  }

  public componentAdded(entity: Entity): void {
    this._add(entity);
  }

  public componentChanged(entity: Entity): void {
    this._emitRefresh(entity);
  }

  public componentRemoved(entity: Entity): void {
    this._delete(entity);
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && entity._get(this.componentEid) !== undefined;
  }
}
