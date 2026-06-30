import { ChildOf, Module, PRE_STORE } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";
import { updateRenderPosition } from "../../math.js";
import { Electron, LocalOffsetComponents, Offset } from "./components.js";

export class LocalOffsetsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(LocalOffsetComponents);

    world
      .system("OrbitElectrons")
      .with(Offset, Electron)
      .each([Offset, Electron], (entity, [offset, electron]) => {
        electron.angle += electron.speed;
        offset.x = Math.cos(electron.angle) * electron.radius;
        offset.y = Math.sin(electron.angle) * electron.radius;
        entity.modified(Electron);
        entity.modified(Offset);
      });

    world
      .system("ApplyLocalPositions")
      .with(RenderPosition, Offset)
      .cascade(ChildOf)
      .phase(PRE_STORE)
      .each(
        [Offset, RenderPosition, { target: [ChildOf, [RenderPosition]] }],
        (entity, [offset, position, parentPosition]) => {
          if (parentPosition === undefined) {
            return;
          }

          updateRenderPosition(
            entity,
            position,
            parentPosition.x + offset.x,
            parentPosition.y + offset.y
          );
        }
      );
  }
}
