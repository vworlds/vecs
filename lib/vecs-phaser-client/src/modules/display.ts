import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { DrawBy, DrawIn, Position } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

/**
 * Display-list placement for Phaser GameObjects.
 *
 * Shape modules create GameObjects via `new Phaser.GameObjects.X(scene, …)`
 * (no display-list entry). This module is the single point that adds each
 * GameObject to the correct display parent:
 *
 * - **Root entities** (no `DrawIn`/`DrawBy`): `scene.add.existing(obj)`.
 * - **Native children** (`DrawIn`, parent has `Container`):
 *   `parentContainer.add(obj)`. Phaser composes transforms natively — moving
 *   the Container moves all children, rotation/scale propagate for free.
 * - **Computed children** (`DrawBy`, parent is a renderable): placed on the
 *   scene root (like a root entity), but only after the parent has arrived and
 *   has a `Position`. If the parent is a ghost (not yet arrived or no
 *   `Position`), the child stays off-display until the parent materialises.
 * - **Ghost-parent** (parent not yet arrived): skipped; the object stays
 *   off-display until the parent's Container arrives (handled by
 *   ContainerModule) or the parent gets a `Position` (handled by
 *   `phaser.display.drawby-place`).
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

        // Native children via DrawIn: place inside the parent's Container if
        // it exists. Otherwise skip — the object stays invisible until the
        // parent's Container arrives (ContainerModule adopts it).
        const drawInParent = entity.target(DrawIn);
        if (drawInParent) {
          if (drawInParent.has(containerClass)) {
            const parentContainer = drawInParent.get(containerClass) as
              Phaser.GameObjects.Container | undefined;
            if (parentContainer) {
              parentContainer.add(obj);
            }
          }
          return;
        }

        // Computed children via DrawBy: place on the scene root, but only if
        // the parent has arrived and has a Position. If the parent is a ghost,
        // skip — the child stays invisible until the parent materialises
        // (phaser.display.drawby-place re-evaluates each frame).
        const drawByParent = entity.target(DrawBy);
        if (drawByParent) {
          if (drawByParent.has(Position)) {
            scene.add.existing(obj);
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

    // DrawBy ghost-parent placement: each frame, place any DrawBy child whose
    // GameObject has no display list and whose parent has arrived with a
    // Position. Idempotent — skips already-placed objects. Handles the case
    // where the child entered the scene before its parent materialised.
    world
      .system("phaser.display.drawby-place")
      .with(DrawBy, m.GameObject)
      .without(DrawIn)
      .phase(ON_STORE)
      .each([m.GameObject], (entity, [obj]) => {
        const phaserObj = obj as Phaser.GameObjects.GameObject;
        if (phaserObj.displayList !== null) {
          return;
        }
        const parent = entity.target(DrawBy);
        if (parent && parent.has(Position)) {
          scene.add.existing(phaserObj);
        }
      });
  }
}
