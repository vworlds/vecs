import { CleanupPolicy, Exclusive, Implements, Module, ON_STORE, Traversable } from "@vworlds/vecs";
import Phaser from "phaser";
import { Container, DrawBy, DrawIn, Position } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class DisplaySetupModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    world.component(Phaser.GameObjects.Container).set(Implements, {
      interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth],
    });

    // DrawIn: native parenting — child of a Container. Detaching (not
    // destroying) children when a display parent is destroyed. The reparent
    // system re-adds orphaned children to the scene. No Traversable: native
    // children are added to the Phaser Container directly, no ECS cascade.
    const drawIn = world.component(DrawIn);
    drawIn.add(Exclusive);
    drawIn.meta.onDeleteTarget = CleanupPolicy.Remove;

    // DrawBy: computed parenting — child of a renderable, world Position
    // derived each frame. Same Remove policy. Traversable so cascade queries
    // (phaser.resolve.offset, InCell cascade) can reach DrawBy children.
    const drawBy = world.component(DrawBy);
    drawBy.add(Exclusive);
    drawBy.meta.onDeleteTarget = CleanupPolicy.Remove;
    drawBy.add(Traversable);

    // DrawIn and DrawBy are exclusive: adding one removes the other.
    world.setExclusiveComponents(DrawIn, DrawBy);

    // DrawBy auto-adds Position on the client to store the computed value.
    // The Position is client-local (never networked back to the server).
    world.component(DrawBy).on("add", (entity) => entity.add(Position));

    world
      .component(Container)
      .on("remove", (entity) => entity.remove(Phaser.GameObjects.Container));

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
