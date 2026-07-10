import { CleanupPolicy, Implements, Module, ON_STORE, Traversable } from "@vworlds/vecs";
import Phaser from "phaser";
import { Container, DrawIn } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class ContainerModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    world.component(Phaser.GameObjects.Container).set(Implements, {
      interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth],
    });

    // DrawIn: detaching (not destroying) children when a display parent is
    // destroyed. The reparent system re-adds orphaned children to the scene.
    const drawIn = world.component(DrawIn);
    drawIn.meta.onDeleteTarget = CleanupPolicy.Remove;
    drawIn.add(Traversable);

    world.component(Container).onRemove((entity) => entity.remove(Phaser.GameObjects.Container));

    world
      .system("phaser.new.container")
      .with(Container)
      .without(Phaser.GameObjects.Container)
      .phase(ON_STORE)
      .enter((entity) => {
        const obj = new Phaser.GameObjects.Container(scene, 0, 0);
        entity.attach(obj);

        // Reparent any children whose GameObjects were created before this
        // Container arrived (ghost-parent case). The child's display.place
        // enter skipped them; now the Container exists, so adopt them.
        for (const child of entity.children(DrawIn)) {
          const childObj = child.get(m.GameObject) as Phaser.GameObjects.GameObject | undefined;
          if (childObj && childObj.displayList === null) {
            obj.add(childObj);
          }
        }
      });
  }
}
