import {
  Exclusive,
  Implements,
  Module,
  ON_STORE,
  OnDeleteTarget,
  Remove,
  Traversable,
  With,
} from "@vworlds/vecs";
import Phaser from "phaser";
import {
  Container,
  DrawBy,
  DrawIn,
  InheritRotation,
  Position,
  Rotation,
} from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class DisplaySetupModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    world.component(Phaser.GameObjects.Container).set(Implements, {
      interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth],
    });

    // DrawIn: native parenting — child of a Container. Detaching (not
    // destroying) children when a display parent is destroyed. The GameObject
    // remove hook detaches them before Phaser teardown. No Traversable: native
    // children are added to the Phaser Container directly, no ECS cascade.
    const drawIn = world.component(DrawIn);
    drawIn.add(Exclusive).add(OnDeleteTarget, Remove);

    // DrawBy: computed parenting — child of a renderable, world Position
    // derived each frame. Same Remove policy. Traversable so cascade queries
    // (phaser.resolve.offset, InCell cascade) can reach DrawBy children.
    const drawBy = world.component(DrawBy);
    drawBy.add(Exclusive).add(OnDeleteTarget, Remove);
    drawBy.add(Traversable);

    // DrawIn and DrawBy are exclusive: adding one removes the other.
    world.setExclusiveComponents(DrawIn, DrawBy);

    // DrawBy auto-adds Position on the client to store the computed value.
    // The Position is client-local (never networked back to the server).
    world.component(DrawBy).on("add", (entity) => entity.add(Position));

    // InheritRotation puts a DrawBy child in its parent's local frame (see
    // phaser.resolve.offset). A tagged child carries a client-local Rotation that holds the
    // derived world angle, much as a DrawBy child carries its derived Position, so adding the
    // tag adds the Rotation. The target goes by component id: in the published declarations a
    // `Component` entity is not assignable to `ComponentRef`, so passing it fails this
    // package's build.
    const inheritRotation = world.component(InheritRotation);
    inheritRotation.add(With, world.component(Rotation).eid);

    // Removing the tag from a DrawBy child returns the child to its own rotation: its Rotation
    // becomes the tag's local angle, now taken relative to the world, and phaser.resolve.offset
    // stops rotating its offset. The tag does nothing without DrawBy, so on an entity that has
    // none, including a child whose DrawBy was already removed, removal leaves its Rotation alone.
    // A `remove` hook also fires as an entity is destroyed, and a dying entity takes no writes, so
    // it only acts on a live one.
    inheritRotation.on("remove", (entity, tag) => {
      if (entity.destroyed || !entity.has(DrawBy)) {
        return;
      }
      entity.set(Rotation, { angle: tag.angle });
    });

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
