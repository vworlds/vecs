import { Module, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { ScreenAnchor } from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";
import * as m from "../markers.js";

/**
 * Screen-space placement for HUD/UI entities.
 *
 * `phaser.screen-anchor.resize` watches the canvas size each tick (two number
 * compares on idle frames) and re-marks every anchored entity when it
 * changes, so the sync below re-lays the HUD out. `phaser.sync.screen-anchor`
 * converts the math-convention anchor fractions plus meter offsets to screen
 * pixels and pins the GameObject to the camera with scroll factor 0.
 *
 * Declared in this order (resize check before sync, both in ON_STORE) so a
 * resize is applied in the same tick it is detected.
 */
export class ScreenAnchorModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    const anchored = world.query("phaser.screen-anchored").with(ScreenAnchor).track();

    let lastWidth = scene.scale.width;
    let lastHeight = scene.scale.height;
    world
      .system("phaser.screen-anchor.resize")
      .phase(ON_STORE)
      .run(() => {
        if (scene.scale.width === lastWidth && scene.scale.height === lastHeight) {
          return;
        }
        lastWidth = scene.scale.width;
        lastHeight = scene.scale.height;
        anchored.forEach((entity) => entity.modified(ScreenAnchor));
      });

    world
      .system("phaser.sync.screen-anchor")
      .with(ScreenAnchor, m.Transform)
      .phase(ON_STORE)
      .update({ watch: ScreenAnchor, onEnter: true, inject: [m.Transform] }, (_e, a, [obj]) => {
        obj.setScrollFactor(0);
        obj.setPosition(
          scene.scale.width * a.x + coords.len(a.offsetX),
          scene.scale.height * (1 - a.y) - coords.len(a.offsetY)
        );
      });
  }
}
