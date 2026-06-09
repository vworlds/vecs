import type { ClientWorld } from "@vworlds/vecs-client";
import type { EID, System } from "@vworlds/vecs";
import type Phaser from "phaser";

import type { CoordSpace } from "./coord_space.js";

export interface RenderContext {
  readonly world: ClientWorld;
  readonly scene: Phaser.Scene;
  readonly coords: CoordSpace;
  readonly interpolateRotation: boolean;

  getGameObject(eid: EID): Phaser.GameObjects.GameObject | undefined;
  setGameObject(eid: EID, obj: Phaser.GameObjects.GameObject): void;
  deleteGameObject(eid: EID): void;
  trackSystem(system: System): void;
}

export type RenderSystemInstaller = (ctx: RenderContext) => void;
