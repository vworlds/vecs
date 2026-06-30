import { Module, type Entity, type QueryDSL } from "@vworlds/vecs";
import { cellTagComponents, InCell } from "./grid.js";

export class ViewAll {}

export class InterestGridState {
  public cellEntities: Entity[] = [];
  public cellViewDSL: QueryDSL[] = [];
}

export class SpatialInterestComponents extends Module {
  public init(): void {
    this.world.component(InCell);
    this.world.component(InterestGridState);
    this.world.component(ViewAll);
    cellTagComponents.forEach((CellTag) => {
      this.world.component(CellTag);
    });
  }
}

export { cellTagComponents, InCell };
