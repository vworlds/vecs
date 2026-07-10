import { ChildOf, Module, PRE_STORE, type Entity, type QueryDSL } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";
import { NetworkClient, Networked, View } from "@vworlds/vecs-server";
import {
  cellTagComponents,
  InCell,
  InterestGridState,
  SpatialInterestComponents,
  ViewAll,
} from "./components.js";
import { createCellViewDSL, getGridCellIndex } from "./grid.js";

export class SpatialInterestModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(SpatialInterestComponents);

    const cellEntities: Entity[] = cellTagComponents.map((CellTag) => world.entity().add(CellTag));
    const cellViewDSL: QueryDSL[] = cellTagComponents.map((_CellTag, index) =>
      createCellViewDSL(index)
    );
    world.set(InterestGridState, { cellEntities, cellViewDSL });

    world.component(NetworkClient).onSet((entity) => {
      entity.set(View, { dsl: false });
    });

    world
      .system("AssignCells")
      .with(Networked, RenderPosition)
      .phase(PRE_STORE)
      .update({ watch: RenderPosition, onEnter: true }, (entity, position) =>
        assignCell(entity, position, cellEntities)
      );

    // Cascade InCell from parent to children that don't have their own
    // RenderPosition (e.g. child shapes parented via ChildOf to a Container).
    // Without this, parented children are invisible in cell-based views
    // because they never get an InCell assignment. Uses InCell onSet/onRemove
    // hooks so the cascade is immediate — a child assigned the same frame
    // its parent gets a cell, no frame delay.
    world.component(InCell).onSet((entity) => {
      const cell = entity.target(InCell);
      for (const child of entity.children(ChildOf)) {
        if (child.has(Networked) && !child.has(RenderPosition)) {
          if (child.target(InCell) !== cell) {
            child.set(InCell, { target: cell! });
          }
        }
      }
    });

    world.component(InCell).onRemove((entity) => {
      for (const child of entity.children(ChildOf)) {
        if (child.has(Networked) && !child.has(RenderPosition) && child.has(InCell)) {
          child.remove(InCell);
        }
      }
    });

    world
      .system("UpdatePlayerViews")
      .with(Networked, NetworkClient, RenderPosition, View)
      .phase(PRE_STORE)
      .update(
        { watch: RenderPosition, onEnter: true, inject: [View, ViewAll] },
        (entity, position, [view, viewAll]) =>
          updatePlayerView(entity, position, view, cellViewDSL, viewAll !== undefined)
      );

    world
      .system("UpdateViewAll")
      .with(Networked, NetworkClient, RenderPosition, View, ViewAll)
      .phase(PRE_STORE)
      .enter([RenderPosition, View], (entity, [position, view]) => {
        updatePlayerView(entity, position, view, cellViewDSL, true);
      })
      .exit([RenderPosition, View], (entity, [position, view]) => {
        updatePlayerView(entity, position, view, cellViewDSL, false);
      });
  }
}

function assignCell(entity: Entity, position: RenderPosition, cellEntities: Entity[]): void {
  const cell = cellEntities[getGridCellIndex(position)];
  if (entity.target(InCell) !== cell) {
    entity.set(InCell, { target: cell });
  }
}

function updatePlayerView(
  entity: Entity,
  position: RenderPosition,
  view: View,
  cellViewDSL: QueryDSL[],
  viewAll: boolean
): void {
  const dsl: QueryDSL = viewAll ? true : cellViewDSL[getGridCellIndex(position)]!;
  if (view.dsl !== dsl) {
    view.dsl = dsl;
    entity.modified(View);
  }
}
