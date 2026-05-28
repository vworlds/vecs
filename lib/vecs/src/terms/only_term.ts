import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";
import type { getTerm as GetTermFn } from "./build.js";

export class OnlyTerm extends Term {
  public constructor(
    world: World,
    key: string,
    allTerm: Term,
    worldTerm: Term,
    private readonly _componentEids: readonly number[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "only", false, onDestroy);
    this._setChildren([allTerm, worldTerm]);
    if (worldTerm instanceof WorldTerm) {
      this._addChildCleanup(worldTerm.subscribeShape(this));
    }
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    componentEids: readonly number[],
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): OnlyTerm {
    // Build the inner all-term for the component set, then the world leaf.
    const allTerm = getTerm(world, componentEids as number[]);
    const worldTerm = getTerm(world, true);
    return new OnlyTerm(world, key, allTerm, worldTerm, componentEids, onDestroy);
  }

  public override onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

  /** @internal */
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
