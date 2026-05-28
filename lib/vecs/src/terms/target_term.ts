import { Relationship } from "../relationship.js";
import type { QueryDSL } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, TermEventKind } from "./term.js";
import type { getTerm as GetTermFn } from "./build.js";

export class TargetTerm extends Term {
  public constructor(
    world: World,
    key: string,
    private readonly _relationshipEid: number,
    relationshipTerm: Term,
    private readonly _innerTerm: Term,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "target", false, onDestroy);
    this._setChildren([relationshipTerm, _innerTerm]);
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    relationshipEid: number,
    innerDSL: QueryDSL,
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): TargetTerm {
    const relationshipTerm = getTerm(world, relationshipEid);
    const innerTerm = getTerm(world, innerDSL);
    return new TargetTerm(world, key, relationshipEid, relationshipTerm, innerTerm, onDestroy);
  }

  /** @internal */
  protected override _onChildEvent(_kind: TermEventKind, entity: Entity, child: Term): void {
    if (child === this._children[0]) {
      this._sync(entity);
      return;
    }
    entity.children(this._relationshipEid).forEach((source) => this._sync(source));
  }

  /** @internal */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    if (child === this._children[0]) {
      this._sync(entity);
      return;
    }
    entity.children(this._relationshipEid).forEach((source) => this._sync(source));
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    if (entity._destroyed) {
      return false;
    }
    const target = (entity._get(this._relationshipEid) as Relationship | undefined)?.target;
    return target !== undefined && this._innerTerm.has(target);
  }
}
