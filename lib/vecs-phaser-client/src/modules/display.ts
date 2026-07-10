import { ChildOf, Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import * as m from "../markers.js";

/**
 * Places newly-created Phaser GameObjects onto the correct display parent:
 *
 * - **Children of a Container** (case B, or nested Containers) →
 *   `parentContainer.add(obj)`.
 * - **Root Containers** (no `ChildOf`) → `scene.add.existing(container)`.
 * - **Root renderables** (no `ChildOf`, case A) → `scene.add.existing(obj)`.
 * - **Children of a Renderable** (case C) or **ghost-parent** (parent not yet
 *   arrived) → skipped; the object stays off-display until the parent's
 *   Container materialises or the case-C compute system derives a `Position`.
 *
 * `ChildOf` is checked before the Container-vs-renderable distinction so that
 * a Container that is itself a child (e.g. an intermediate orbit Container) is
 * nested inside its parent Container, not placed on the scene.
 *
 * GameObjects are created without a display-list entry (shape modules use
 * `new Phaser.GameObjects.X(scene, …)` instead of `scene.add.X(…)`). This
 * module is the single point that adds them to the scene or a parent Container,
 * preventing ghost-parented children from flashing at screen `(0,0)`.
 */
export class DisplayModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    const containerClass = Phaser.GameObjects.Container;

    world
      .system("phaser.display.place")
      .with(m.GameObject)
      .phase(ON_STORE)
      .enter((entity) => {
        const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
        if (!obj || obj.displayList !== null) {
          return;
        }

        // Children via ChildOf: place inside the parent's Container if it
        // exists (case B, or a nested Container). Otherwise skip — the object
        // stays invisible until the parent's Container arrives or the case-C
        // compute system derives a Position.
        const childOf = entity.get(ChildOf);
        if (childOf) {
          const parent = childOf.target;
          if (parent && parent.has(containerClass)) {
            const parentContainer = parent.get(containerClass) as Phaser.GameObjects.Container;
            if (parentContainer) {
              parentContainer.add(obj);
            }
          }
          return;
        }

        // Root entity (case A, or root Container): place on the scene.
        scene.add.existing(obj);
      });

    // Reparent when ChildOf is retargeted or removed. The old display parent
    // (scene or Container) no longer owns the child; re-evaluate placement.
    world.component(ChildOf).onSet((entity) => {
      const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
      if (!obj || obj.displayList === null) {
        return;
      }
      const childOf = entity.get(ChildOf);
      const parent = childOf?.target;
      const parentContainer =
        parent && parent.has(containerClass)
          ? (parent.get(containerClass) as Phaser.GameObjects.Container)
          : undefined;

      if (parentContainer && obj.parentContainer !== parentContainer) {
        parentContainer.add(obj);
      } else if (!parentContainer && obj.parentContainer !== null) {
        scene.add.existing(obj);
      }
    });

    world.component(ChildOf).onRemove((entity) => {
      const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
      if (!obj) {
        return;
      }
      // Detach from the parent Container if it was in one, then add to scene.
      if (obj.parentContainer !== null) {
        (obj.parentContainer as Phaser.GameObjects.Container).remove(obj, false);
      }
      if (obj.displayList === null) {
        scene.add.existing(obj);
      }
    });
  }
}
