import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { DrawIn } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

/**
 * Display-list placement for Phaser GameObjects.
 *
 * Shape modules create GameObjects via `new Phaser.GameObjects.X(scene, …)`
 * (no display-list entry). This module is the single point that adds each
 * GameObject to the correct display parent:
 *
 * - **Root entities** (no `DrawIn` parent): `scene.add.existing(obj)`.
 * - **Children of a Container** (native parenting): `parentContainer.add(obj)`.
 *   Phaser composes transforms natively — moving the Container moves all
 *   children, rotation/scale propagate for free.
 * - **Children of a Renderable** (computed parenting) or **ghost-parent**
 *   (parent not yet arrived): skipped; the object stays off-display until
 *   the parent's Container materialises (handled by ContainerModule) or the
 *   compute system derives a `Position`.
 *
 * A `Container` that is itself a child (e.g. an intermediate orbit Container) is
 * nested inside its parent Container, not placed on the scene — `DrawIn` is
 * checked before the Container-vs-renderable distinction.
 *
 * Reparenting on `DrawIn` retarget or removal is handled by the
 * `phaser.display.reparent` system, which runs in `ON_STORE` after shape
 * creation so the display list is updated at a controlled phase.
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

        // Children via DrawIn: place inside the parent's Container if it
        // exists. Otherwise skip — the object stays invisible until the
        // parent's Container arrives (ContainerModule adopts it) or the
        // compute system derives a Position.
        const parent = entity.target(DrawIn);
        if (parent) {
          if (parent.has(containerClass)) {
            const parentContainer = parent.get(containerClass) as Phaser.GameObjects.Container;
            if (parentContainer) {
              parentContainer.add(obj);
            }
          }
          return;
        }

        // Root entity: place on the scene.
        scene.add.existing(obj);
      });

    // Reparent when DrawIn changes or is removed. Runs in ON_STORE so the
    // display list is updated at a controlled phase, after shape creation.
    world
      .system("phaser.display.reparent")
      .with(m.GameObject, DrawIn)
      .phase(ON_STORE)
      .update(
        { watch: DrawIn, onEnter: true, inject: [m.GameObject] },
        (entity, _drawIn, [obj]) => {
          const phaserObj = obj as Phaser.GameObjects.GameObject;
          const parent = entity.target(DrawIn);
          const parentContainer =
            parent && parent.has(containerClass)
              ? (parent.get(containerClass) as Phaser.GameObjects.Container)
              : undefined;

          if (parentContainer && phaserObj.parentContainer !== parentContainer) {
            parentContainer.add(phaserObj);
          }
        }
      )
      .exit((entity) => {
        // DrawIn was removed: detach from parent Container, re-add to scene.
        // If the GameObject itself was removed (shape change/destroy), the
        // object is already destroyed — skip.
        const obj = entity.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
        if (!obj || (obj as unknown as { destroyed: boolean }).destroyed) {
          return;
        }
        // The parent Container may have been destroyed already (cascade
        // ordering: m.GameObject.onRemove destroys the Phaser Container,
        // which destroys its children; then DrawIn's Remove policy fires
        // the exit). If the parent is gone, just clear the reference.
        const parent = obj.parentContainer as
          (Phaser.GameObjects.Container & { destroyed?: boolean }) | null;
        if (parent && !parent.destroyed) {
          parent.remove(obj, false);
        }
        if (obj.displayList === null) {
          scene.add.existing(obj);
        }
      });
  }
}
