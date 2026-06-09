import type { ClientWorld } from "@vworlds/vecs-client";
import type { EID, System } from "@vworlds/vecs";
import type Phaser from "phaser";

import { CoordSpace } from "./coord_space.js";
import type { RenderContext } from "./render_context.js";
import { installRenderSystems } from "./renderers/index.js";

export interface PhaserVecsRuntimeOptions {
  world: ClientWorld;
  scene: Phaser.Scene;
  pixelsPerMeter?: number;
  interpolateRotation?: boolean;
}

export class PhaserVecsRuntime {
  private readonly _world: ClientWorld;
  private readonly _scene: Phaser.Scene;
  private readonly _coords: CoordSpace;
  private readonly _interpolateRotation: boolean;
  private readonly _gameObjects = new Map<EID, Phaser.GameObjects.GameObject>();
  private readonly _systems: System[] = [];
  private readonly _resetHandler = (): void => this._handleReset();
  private _started = false;
  private _systemsInstalled = false;

  constructor(options: PhaserVecsRuntimeOptions) {
    this._world = options.world;
    this._scene = options.scene;
    this._coords = new CoordSpace(options.scene, options.pixelsPerMeter);
    this._interpolateRotation = options.interpolateRotation ?? true;
  }

  start(): void {
    if (this._started) {
      return;
    }
    this._enableSystems();
    this._world.events.on("reset", this._resetHandler);
    this._started = true;
  }

  stop(): void {
    if (!this._started) {
      return;
    }
    this._world.events.off("reset", this._resetHandler);
    this._disableSystems();
    this._destroyGameObjects();
    this._started = false;
  }

  getGameObject(eid: EID): Phaser.GameObjects.GameObject | undefined {
    return this._gameObjects.get(eid);
  }

  private _createRenderContext(): RenderContext {
    return {
      world: this._world,
      scene: this._scene,
      coords: this._coords,
      interpolateRotation: this._interpolateRotation,
      getGameObject: (eid) => this.getGameObject(eid),
      setGameObject: (eid, obj) => this._gameObjects.set(eid, obj),
      deleteGameObject: (eid) => {
        this._gameObjects.delete(eid);
      },
      trackSystem: (system) => this._systems.push(system),
    };
  }

  private _destroyGameObjects(): void {
    this._gameObjects.forEach((obj) => obj.destroy());
    this._gameObjects.clear();
  }

  private _disableSystems(): void {
    this._systems.forEach((system) => system.disable());
  }

  private _enableSystems(): void {
    if (!this._systemsInstalled) {
      installRenderSystems(this._createRenderContext());
      this._systemsInstalled = true;
      return;
    }
    this._systems.forEach((system) => system.enable());
  }

  private _handleReset(): void {
    // Baseline reset should route renderer exits, but destroy any object still
    // mapped here so queued or missing exits cannot leak Phaser objects.
    this._destroyGameObjects();
  }
}
