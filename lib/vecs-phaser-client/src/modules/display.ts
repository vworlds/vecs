import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { DrawBy, DrawIn, Position } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

/**
 * Display-list placement for Phaser GameObjects.
 *
 * Shape modules create GameObjects via `new Phaser.GameObjects.X(scene, …)`
 * (no display-list entry). This module adds each GameObject to the correct
 * display parent, split into three systems matching the three rendering modes:
 *
 * - **A — Root** (`phaser.display.root`): entities with `m.GameObject` but no
 *   `DrawIn`/`DrawBy`. Placed on the scene display list.
 * - **B — Native** (`phaser.display.native`): entities with `DrawIn` whose
 *   parent (via DrawIn) has a `Phaser.GameObjects.Container`. The child's
 *   GameObject is added to the parent Container. Phaser composes transforms
 *   natively. The query only matches when the parent has arrived with a
 *   Container, so ghost-parented children stay off-display until the parent
 *   materialises (at which point `enter` fires automatically).
 * - **C — Computed** (`phaser.display.computed`): entities with `DrawBy`
 *   whose parent (via DrawBy) has a `Position`. Placed on the scene display
 *   list (not inside a Container). The query only matches when the parent
 *   has arrived with a Position, so ghost-parented children stay off-display
 *   until the parent materialises.
 *
 * Reparenting (DrawIn/DrawBy retarget) is handled by `update` watching the
 * relationship — the entity exits the old query and enters the new one,
 * triggering `exit` (detach from old parent) and `enter` (attach to new parent).
 * Container teardown detaches surviving children before Phaser destroys the parent;
 * exits skip objects whose Phaser `isDestroyed` flag is set.
 */
export class DisplayModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    const containerClass = Phaser.GameObjects.Container;

    // A — Root: no DrawIn, no DrawBy.
    world
      .system("phaser.display.root")
      .with(m.GameObject)
      .without(DrawIn)
      .without(DrawBy)
      .phase(ON_STORE)
      .enter([m.GameObject], (_entity, [obj]) => {
        const phaserObj = obj as Phaser.GameObjects.GameObject;
        if (phaserObj.isDestroyed || phaserObj.displayList !== null) {
          return;
        }
        scene.add.existing(phaserObj);
      });

    // B — Native: DrawIn target has a Phaser Container.
    world
      .system("phaser.display.native")
      .with(m.GameObject, { target: [DrawIn, containerClass] })
      .phase(ON_STORE)
      .update(
        {
          watch: DrawIn,
          onEnter: true,
          inject: [m.GameObject, { target: [DrawIn, [containerClass]] }],
        },
        (entity, _drawIn, [obj, parentContainerInjected]) => {
          const phaserObj = obj as Phaser.GameObjects.GameObject;
          const parentContainer = parentContainerInjected as Phaser.GameObjects.Container;
          if (phaserObj.parentContainer !== parentContainer) {
            parentContainer.add(phaserObj);
          }
        }
      )
      .exit((entity) => {
        const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
        if (!obj || obj.isDestroyed) {
          return;
        }
        const parent = obj.parentContainer;
        if (parent && !parent.isDestroyed) {
          parent.remove(obj, false);
        }
        if (obj.displayList === null) {
          scene.add.existing(obj);
        }
      });

    // C — Computed: DrawBy target has a Position.
    world
      .system("phaser.display.computed")
      .with(m.GameObject, { target: [DrawBy, Position] })
      .phase(ON_STORE)
      .update(
        { watch: DrawBy, onEnter: true, inject: [m.GameObject] },
        (entity, _drawBy, [obj]) => {
          const phaserObj = obj as Phaser.GameObjects.GameObject;
          if (phaserObj.displayList === null) {
            scene.add.existing(phaserObj);
          }
        }
      )
      .exit((entity) => {
        // DrawBy removed or parent lost Position — child stays on scene.
        // No Container to detach from; if the GameObject is being destroyed
        // it's already gone.
        const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
        if (!obj || obj.isDestroyed) {
          return;
        }
        // The child remains on the scene root. Nothing to do.
      });
  }
}
