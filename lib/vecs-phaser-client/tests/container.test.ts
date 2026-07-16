import { ChildOf } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Container,
  DrawBy,
  DrawIn,
  Ellipse,
  FillStyle,
  Offset,
  Position,
  Rotation,
  Size,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

import * as m from "../src/markers.js";
import { PhaserRenderModule } from "../src/index.js";
import { createMockScene, type MockGameObject } from "./mock_phaser.js";

function setup() {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100 });
  return { scene, world };
}

function methods(obj: MockGameObject, method: string): readonly (readonly unknown[])[] {
  return obj.calls.filter((call) => call.method === method).map((call) => call.args);
}

function lastCall(obj: MockGameObject, method: string): readonly unknown[] | undefined {
  const calls = methods(obj, method);
  return calls[calls.length - 1];
}

function findContainer(scene: ReturnType<typeof createMockScene>): MockGameObject | undefined {
  return scene.created.find((obj) => obj.kind === "container");
}

describe("Container rendering", () => {
  it("creates a Phaser Container when the Container component is added", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.add(Container).set(Position, { x: 1, y: 2 });
    world.progress(0, 0);

    const container = findContainer(scene);
    expect(container).toBeDefined();
    expect(container!.kind).toBe("container");
    expect(entity.get(Phaser.GameObjects.Container)).toBe(container);
    expect(entity.get(m.GameObject)).toBe(container);
    expect(entity.get(m.Transform)).toBe(container);
  });

  it("positions the Container via phaser.sync.position like any renderable", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.add(Container).set(Position, { x: 1, y: 2 });
    world.progress(0, 0);

    const container = findContainer(scene)!;
    // x = 1024/2 + 100*1 = 612, y = 768/2 - 100*2 = 184
    expect(lastCall(container, "setPosition")).toEqual([612, 184]);
  });

  it("places the Container on the scene display list", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const container = findContainer(scene)!;
    expect(container!.displayList).not.toBe(null);
  });
});

describe("Native parenting: child of Container with Offset", () => {
  it("adds the child Renderable to the parent Container", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const container = findContainer(scene)!;

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0.5, y: -0.3 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse).toBeDefined();
    expect(ellipse.parentContainer).toBe(container);
  });

  it("sets the child local position from Offset via phaser.sync.offset", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0.5, y: -0.3 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    // rx = 100 * 0.5 = 50, ry = -100 * (-0.3) = 30
    expect(lastCall(ellipse, "setPosition")).toEqual([50, 30]);
  });

  it("does not set absolute Position on the child (no Position component)", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 5, y: 5 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 1, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    // Should only have the local offset setPosition, not an absolute one
    const positionCalls = methods(ellipse, "setPosition");
    expect(positionCalls).toHaveLength(1);
    // rx(1) = 100, ry(0) = -0 (negative zero from Y-flip)
    expect(positionCalls[0]![0]).toBe(100);
    expect(Object.is(positionCalls[0]![1], -0)).toBe(true);
  });
});

describe("Computed parenting: child of Renderable with Offset + Position", () => {
  it("computes world Position from parent Position + rotated Offset", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent
      .set(Position, { x: 2, y: 3 })
      .set(Rotation, { angle: 0 })
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .set(Offset, { x: 1, y: 0 })
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    // DrawBy auto-adds Position at {0,0}; resolve computes from parent.
    // Parent at (2,3), no rotation, offset (1,0) → child at (3,3)
    expect(child.get(Position)).toMatchObject({ x: 3, y: 3 });
  });

  it("adds offset without parent rotation (rotation conditioned by tag in future)", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent
      .set(Position, { x: 0, y: 0 })
      .set(Rotation, { angle: Math.PI / 2 })
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .set(Offset, { x: 1, y: 0 })
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    // Parent at (0,0), offset (1,0) → child at (1,0). Parent rotation
    // is not applied to the offset (will be conditioned by a tag later).
    const pos = child.get(Position)!;
    expect(pos.x).toBeCloseTo(1, 5);
    expect(pos.y).toBeCloseTo(0, 5);
  });

  it("auto-adds Position when DrawBy is set", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent
      .set(Position, { x: 5, y: 5 })
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    // DrawBy auto-adds Position; Offset is optional (defaults 0,0).
    // Parent at (5,5), offset (0,0) → child at (5,5).
    expect(child.has(Position)).toBe(true);
    expect(child.get(Position)).toMatchObject({ x: 5, y: 5 });
  });
});

describe("Ghost parent", () => {
  it("keeps the child off-display when parent Container does not exist yet", () => {
    const { scene, world } = setup();

    // Create a child referencing a parent that doesn't have a Container yet
    const parentGhost = world.entity();
    const child = world.entity();
    child
      .add(DrawIn, parentGhost)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(0, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse).toBeDefined();
    // The child should NOT be on any display list (no parent Container yet)
    expect(ellipse.displayList).toBe(null);
    expect(ellipse.parentContainer).toBe(null);
  });

  it("adopts the child into the Container when the parent materialises", () => {
    const { scene, world } = setup();

    const parent = world.entity();
    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(0, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse.displayList).toBe(null);

    // Now the parent gets a Container
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(1, 0);

    const container = findContainer(scene)!;
    expect(ellipse.parentContainer).toBe(container);
  });
});

describe("Container lifetime (DrawIn = Remove policy)", () => {
  it("detaches display children when the parent Container is destroyed", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse.destroyed).toBe(false);

    // Destroying the parent removes the DrawIn link (Remove policy).
    // The child survives; the reparent exit re-adds it to the scene.
    parent.destroy();
    world.progress(2, 0);

    expect(ellipse.destroyed).toBe(false);
    expect(child.has(DrawIn)).toBe(false);
    expect(ellipse.parentContainer).toBe(null);
    expect(ellipse.displayList).not.toBe(null);
  });
});

describe("ChildOf + DrawIn coexistence", () => {
  it("an entity can have both ChildOf (ownership) and DrawIn (display)", () => {
    const { scene, world } = setup();
    const owner = world.entity();
    owner.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    // A display child that also has an ownership parent (different entity).
    // DrawIn points at the display parent (Container); ChildOf points at the
    // ownership parent (could be the same or a different entity).
    const displayParent = owner;
    const ownershipParent = world.entity();

    const child = world.entity();
    child
      .childOf(ownershipParent)
      .add(DrawIn, displayParent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    // DrawIn drives display placement — the ellipse is inside the Container.
    const container = findContainer(scene)!;
    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse.parentContainer).toBe(container);

    // ChildOf drives ownership — the child's parent is the ownership parent.
    expect(child.parent).toBe(ownershipParent);

    // Both relationships coexist independently.
    expect(child.has(ChildOf)).toBe(true);
    expect(child.has(DrawIn)).toBe(true);
  });

  it("destroying the ownership parent destroys the child (ChildOf Delete cascade)", () => {
    const { scene, world } = setup();
    const displayParent = world.entity();
    displayParent.add(Container).set(Position, { x: 0, y: 0 });
    const ownershipParent = world.entity();
    world.progress(0, 0);

    const child = world.entity();
    child
      .childOf(ownershipParent)
      .add(DrawIn, displayParent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;

    // Destroying the ownership parent cascades Delete via ChildOf.
    ownershipParent.destroy();
    world.progress(2, 0);

    expect(ellipse.destroyed).toBe(true);
  });

  it("destroying the display parent detaches but does not destroy the child", () => {
    const { scene, world } = setup();
    const displayParent = world.entity();
    displayParent.add(Container).set(Position, { x: 0, y: 0 });
    const ownershipParent = world.entity();
    world.progress(0, 0);

    const child = world.entity();
    child
      .childOf(ownershipParent)
      .add(DrawIn, displayParent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;

    // Destroying the display parent removes DrawIn (Remove policy) but
    // the child survives because ChildOf points elsewhere.
    displayParent.destroy();
    world.progress(2, 0);

    expect(ellipse.destroyed).toBe(false);
    expect(child.has(DrawIn)).toBe(false);
    expect(child.has(ChildOf)).toBe(true);
  });
});

describe("Container exclusivity", () => {
  it("Container and Renderable GameObjects are exclusive via Implements", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity
      .add(Container)
      .set(Position, { x: 0, y: 0 })
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(0, 0);

    // Both data components exist (client doesn't enforce data exclusivity),
    // but only one concrete GameObject survives (Implements eviction).
    const container = entity.get(Phaser.GameObjects.Container);
    const ellipse = entity.get(Phaser.GameObjects.Ellipse);
    const gameObject = entity.get(m.GameObject);

    // Exactly one concrete object should be attached
    expect(container === undefined || ellipse === undefined).toBe(true);
    expect(gameObject).toBeDefined();
    // The surviving object should be one of them
    expect([container, ellipse]).toContain(gameObject);
  });
});

describe("Reparenting", () => {
  it("moves child to new parent Container when DrawIn is retargeted", () => {
    const { scene, world } = setup();
    const parent1 = world.entity();
    parent1.add(Container).set(Position, { x: 0, y: 0 });
    const parent2 = world.entity();
    parent2.add(Container).set(Position, { x: 5, y: 5 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent1)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    const containers = scene.created.filter((obj) => obj.kind === "container");
    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse.parentContainer).toBe(containers[0]);

    // Retarget to parent2
    child.add(DrawIn, parent2);
    world.progress(2, 0);

    expect(ellipse.parentContainer).toBe(containers[1]);
  });

  it("moves child to scene display list when DrawIn is removed", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 0, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    expect(ellipse.parentContainer).not.toBe(null);

    child.remove(DrawIn);
    world.progress(2, 0);

    expect(ellipse.parentContainer).toBe(null);
    expect(ellipse.displayList).not.toBe(null);
  });
});

describe("Nested Containers", () => {
  it("places a child Container inside its parent Container, not on the scene", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 1, y: 1 });
    world.progress(0, 0);

    const childContainer = world.entity();
    childContainer.add(DrawIn, parent).add(Container).set(Rotation, { angle: 0.5 });
    world.progress(1, 0);

    const containers = scene.created.filter((obj) => obj.kind === "container");
    const parentObj = containers[0]!;
    const childObj = containers[1]!;

    // The parent Container should be on the scene.
    expect(parentObj.parentContainer).toBe(null);
    expect(parentObj.displayList).not.toBe(null);

    // The child Container should be inside the parent Container, NOT on the scene.
    expect(childObj.parentContainer).toBe(parentObj);
  });
});

describe("DrawIn / DrawBy exclusivity", () => {
  it("adding DrawBy removes DrawIn", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child.add(DrawIn, parent).add(Ellipse).set(Size, { width: 0.1, height: 0.1 });
    expect(child.has(DrawIn)).toBe(true);
    expect(child.has(DrawBy)).toBe(false);

    child.add(DrawBy, parent);
    expect(child.has(DrawIn)).toBe(false);
    expect(child.has(DrawBy)).toBe(true);
  });

  it("adding DrawIn removes DrawBy", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child.add(DrawBy, parent).add(Ellipse).set(Size, { width: 0.1, height: 0.1 });
    expect(child.has(DrawBy)).toBe(true);

    child.add(DrawIn, parent);
    expect(child.has(DrawBy)).toBe(false);
    expect(child.has(DrawIn)).toBe(true);
  });
});

describe("phaser.sync.position guard (DrawIn)", () => {
  it("does not call setPosition with world coords on a DrawIn child", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent.add(Container).set(Position, { x: 0, y: 0 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawIn, parent)
      .set(Position, { x: 10, y: 10 })
      .add(Ellipse)
      .set(Size, { width: 0.1, height: 0.1 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 })
      .set(Offset, { x: 1, y: 0 });
    world.progress(1, 0);

    const ellipse = scene.created.find((obj) => obj.kind === "ellipse")!;
    // Only the local offset setPosition should fire (rx(1)=100), never the
    // world-coords setPosition from Position (the .without(DrawIn) guard).
    const positionCalls = methods(ellipse, "setPosition");
    expect(positionCalls).toHaveLength(1);
    expect(positionCalls[0]![0]).toBe(100);
  });
});

describe("DrawBy ghost parent", () => {
  it("keeps the child off-display when parent has no Position", () => {
    const { scene, world } = setup();

    // Parent exists as an entity but has no Position yet (ghost).
    const parent = world.entity();
    parent
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    const ellipses = scene.created.filter((obj) => obj.kind === "ellipse");
    const childEllipse = ellipses[1]!;
    expect(childEllipse).toBeDefined();
    // Child stays off-display until parent gets a Position.
    expect(childEllipse.displayList).toBe(null);
  });

  it("places the child on the scene when the parent materialises with Position", () => {
    const { scene, world } = setup();

    const parent = world.entity();
    parent
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    const ellipses = scene.created.filter((obj) => obj.kind === "ellipse");
    const childEllipse = ellipses[1]!;
    expect(childEllipse.displayList).toBe(null);

    // Parent gets a Position — child should be placed on the scene.
    parent.set(Position, { x: 1, y: 1 });
    world.progress(2, 0);

    expect(childEllipse.displayList).not.toBe(null);
  });
});

describe("DrawBy optional Offset (defaults to 0,0)", () => {
  it("derives Position as parent Position when no Offset is set", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent
      .set(Position, { x: 3, y: 4 })
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    // No Offset component — defaults to (0,0), child sits at parent (3,4).
    expect(child.get(Position)).toMatchObject({ x: 3, y: 4 });
  });
});

describe("DrawBy lifetime (Remove policy)", () => {
  it("detaches but does not destroy the child when the parent is destroyed", () => {
    const { scene, world } = setup();
    const parent = world.entity();
    parent
      .set(Position, { x: 0, y: 0 })
      .add(Ellipse)
      .set(Size, { width: 0.2, height: 0.2 })
      .set(FillStyle, { color: 0x00ff00, alpha: 1 });
    world.progress(0, 0);

    const child = world.entity();
    child
      .add(DrawBy, parent)
      .add(Ellipse)
      .set(Size, { width: 0.05, height: 0.05 })
      .set(FillStyle, { color: 0xff0000, alpha: 1 });
    world.progress(1, 0);

    const ellipses = scene.created.filter((obj) => obj.kind === "ellipse");
    const childEllipse = ellipses[1]!;
    expect(childEllipse.destroyed).toBe(false);

    // Destroying the parent removes the DrawBy link (Remove policy).
    // The child survives on the scene.
    parent.destroy();
    world.progress(2, 0);

    expect(childEllipse.destroyed).toBe(false);
    expect(child.has(DrawBy)).toBe(false);
  });
});
