import { Module, ON_STORE, type Entity } from "@vworlds/vecs";
import type Phaser from "phaser";
import {
  CameraBounds,
  CameraFollow,
  CameraShake,
  CameraZoom,
  Position,
} from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";

export interface CameraModuleConfig {
  readonly scene: Phaser.Scene;
  /** Pixels per meter; must match the render module. Default 64. */
  readonly pixelsPerMeter?: number;
  /**
   * The session entity id whose camera components this client obeys. When
   * omitted, it is resolved automatically via `ClientWorld.sessionEntity()`.
   * Camera components on any other entity are ignored (other players'
   * session entities may be in view).
   */
  readonly sessionEid?: number;
}

/**
 * Drives `scene.cameras.main` from the camera components on this client's
 * **session entity** (`CameraFollow`, `CameraZoom`, `CameraBounds`,
 * `CameraShake`). The server controls every client's camera by setting
 * components on the corresponding session entity — no camera code in game
 * clients.
 *
 * Follow runs as a per-tick system in `ON_STORE` (after the sync systems
 * have applied interpolated positions): it centers the camera on the
 * followed entity's `Position`, easing by `CameraFollow.lerp`.
 */
export class CameraModule extends Module<CameraModuleConfig> {
  public init(config: CameraModuleConfig): void {
    const world = this.world;
    const scene = config.scene;
    const coords = new CoordSpace(scene, config.pixelsPerMeter);

    let sessionEid = config.sessionEid ?? 0;
    if (!sessionEid) {
      const clientWorld = world as { sessionEntity?: () => Promise<Entity> };
      void clientWorld.sessionEntity?.().then((entity) => {
        sessionEid = entity.eid;
      });
    }
    const isSession = (entity: Entity): boolean => entity.eid === sessionEid;

    world
      .system("phaser.camera.zoom")
      .with(CameraZoom)
      .phase(ON_STORE)
      .update({ watch: CameraZoom, onEnter: true }, (entity, zoom) => {
        if (isSession(entity)) {
          scene.cameras.main.setZoom(zoom.value);
        }
      })
      .exit((entity) => {
        if (isSession(entity)) {
          scene.cameras.main.setZoom(1);
        }
      });

    world
      .system("phaser.camera.bounds")
      .with(CameraBounds)
      .phase(ON_STORE)
      .update({ watch: CameraBounds, onEnter: true }, (entity, bounds) => {
        if (isSession(entity)) {
          scene.cameras.main.setBounds(
            coords.x(bounds.x),
            coords.y(bounds.y + bounds.height),
            coords.len(bounds.width),
            coords.len(bounds.height)
          );
        }
      })
      .exit((entity) => {
        if (isSession(entity)) {
          scene.cameras.main.removeBounds();
        }
      });

    world
      .system("phaser.camera.shake")
      .with(CameraShake)
      .phase(ON_STORE)
      .update({ watch: CameraShake, onEnter: true }, (entity, shake) => {
        if (isSession(entity)) {
          scene.cameras.main.shake(shake.duration * 1000, shake.intensity);
        }
      });

    world
      .system("phaser.camera.follow")
      .phase(ON_STORE)
      .run(() => {
        if (!sessionEid) {
          return;
        }
        const session = world.getEntity(sessionEid);
        const follow = session?.get(CameraFollow);
        const position = session?.target(CameraFollow)?.get(Position);
        if (!follow || !position) {
          return;
        }
        const camera = scene.cameras.main;
        const desiredX = coords.x(position.x) - camera.width / 2;
        const desiredY = coords.y(position.y) - camera.height / 2;
        const t = Math.min(1, Math.max(0, follow.lerp));
        camera.setScroll(
          camera.scrollX + (desiredX - camera.scrollX) * t,
          camera.scrollY + (desiredY - camera.scrollY) * t
        );
      });
  }
}
