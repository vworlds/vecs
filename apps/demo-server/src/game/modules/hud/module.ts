import { ChildOf, Module, type Entity, type World } from "@vworlds/vecs";
import { ScreenAnchor, Text, TextAlign } from "@vworlds/vecs-phaser";
import { Networked } from "@vworlds/vecs-server";
import { TANK_TINTS } from "../../config.js";
import { Tank } from "../tanks/components.js";

/**
 * Replicated HUD, no client UI code: every element is a networked `Text`
 * pinned to the screen with `ScreenAnchor` (normalized fractions + meter
 * offsets, math convention — y = 1 is the top edge).
 *
 * Each tank's scoreboard row is a `ChildOf` child of the tank, so a
 * disconnect removes the row automatically; the row text updates reactively
 * when the score changes (`.update(Tank)` — no per-tick scanning).
 */
export class HudModule extends Module {
  public init(): void {
    const world = this.world;

    world
      .entity()
      .add(Networked)
      .set(Text, { align: TextAlign.Center, color: 0x9aa0aa, fontSize: 14, value: "TANK ARENA" })
      .set(ScreenAnchor, { offsetY: -0.25, x: 0.5, y: 1 });

    world
      .system("hud.scoreboard.row")
      .with(Tank)
      .enter((tankEntity) => {
        const tank = tankEntity.get(Tank)!;
        createScoreRow(world, tankEntity, tank.colorIndex);
      });

    world.system("hud.scoreboard.update").update(Tank, (tankEntity, tank) => {
      const row = findScoreRow(tankEntity);
      const label = rowLabel(tank);
      if (row && row.get(Text)?.value !== label) {
        row.set(Text, { value: label });
      }
    });
  }
}

/** The scoreboard row is the tank's only ChildOf child carrying a ScreenAnchor. */
function findScoreRow(tankEntity: Entity): Entity | undefined {
  for (const child of tankEntity.children(ChildOf)) {
    if (child.has(ScreenAnchor)) {
      return child;
    }
  }
  return undefined;
}

function createScoreRow(world: World, tankEntity: Entity, colorIndex: number): Entity {
  const tank = tankEntity.get(Tank)!;
  return world
    .entity()
    .childOf(tankEntity)
    .add(Networked)
    .set(Text, { color: TANK_TINTS[colorIndex], fontSize: 14, value: rowLabel(tank) })
    .set(ScreenAnchor, {
      offsetX: 0.25,
      offsetY: -0.4 - colorIndex * 0.22,
      x: 0,
      y: 1,
    });
}

function rowLabel(tank: Readonly<Tank>): string {
  const names = ["GREEN", "BLUE", "RED", "YELLOW"];
  return `${names[tank.colorIndex]}  ${tank.score}`;
}
