import { DrawBy, InheritRotation, Position, Rotation } from "@vworlds/vecs-phaser";
import { describe, expect, it, vi } from "vitest";

import {
  expectPose,
  expectRendered,
  gameObjectOf,
  HALF_PI,
  setup,
  spawnChild,
  spawnParent,
} from "./parenting_fixtures.js";

describe("DisplaySetupModule: InheritRotation", () => {
  describe("companion Rotation", () => {
    it("adds a client-local Rotation when the tag is added", () => {
      const { world } = setup();
      const entity = world.entity();

      entity.set(InheritRotation, { angle: 0.3 });

      expect(entity.get(Rotation)).toEqual({ angle: 0 });
    });

    it("keeps the Rotation an entity already has", () => {
      const { world } = setup();
      const entity = world.entity().set(Rotation, { angle: 1.2 });
      const rotation = entity.get(Rotation);

      entity.set(InheritRotation, { angle: 0.3 });

      expect(entity.get(Rotation)).toBe(rotation);
      expect(entity.get(Rotation)?.angle).toBe(1.2);
    });
  });

  describe("replacing the tag", () => {
    it("re-derives from the new angle, as a replicated update does, instead of removing it", () => {
      const { world } = setup();
      const parent = spawnParent(world, 0, 0, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 1, y: 0 }, tag: 0.25 });
      world.progress(0, 0);

      child.attach(Object.assign(new InheritRotation(), { angle: 0.75 }));

      // Not a removal: the child is not handed back to its own rotation.
      expect(child.get(Rotation)?.angle).toBeCloseTo(HALF_PI + 0.25, 9);
      world.progress(1, 16);
      expectPose(child, { x: 0, y: 1, angle: HALF_PI + 0.75 });
    });
  });

  describe("removing the tag", () => {
    it("returns the child to its own rotation, with its offset no longer rotated", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);
      expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });

      child.remove(InheritRotation);

      // The local angle is now taken relative to the world.
      expect(child.get(Rotation)?.angle).toBe(0.25);
      world.progress(1, 16);
      expectPose(child, { x: 3, y: 3, angle: 0.25 });
      expectRendered(gameObjectOf(child), { x: 3, y: 3, angle: 0.25 });

      // It no longer follows the parent's rotation.
      parent.set(Rotation, { angle: Math.PI });
      world.progress(2, 16);
      expectPose(child, { x: 3, y: 3, angle: 0.25 });
      expectRendered(gameObjectOf(child), { x: 3, y: 3, angle: 0.25 });
    });

    it("does the same when the removal comes from a deferred scope", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);

      world.defer(() => {
        child.remove(InheritRotation);
      });

      expect(child.get(Rotation)?.angle).toBe(0.25);
      world.progress(1, 16);
      expectPose(child, { x: 3, y: 3, angle: 0.25 });
    });

    it("leaves the Rotation of an entity without DrawBy alone", () => {
      const { world } = setup();
      const entity = world
        .entity()
        .set(Rotation, { angle: 1 })
        .set(InheritRotation, { angle: 0.7 });
      expect(entity.has(DrawBy)).toBe(false);

      entity.remove(InheritRotation);

      // The tag did nothing without DrawBy, so removing it does nothing either.
      expect(entity.get(Rotation)?.angle).toBe(1);
    });

    it("leaves the pose of a child whose DrawBy was removed alone", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);
      expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });
      child.remove(DrawBy);

      child.remove(InheritRotation);

      // It keeps the pose it was last resolved to, as it did while it still had the tag.
      expect(child.has(DrawBy)).toBe(false);
      expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });
      world.progress(1, 16);
      expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });
    });

    it("writes nothing to a child that is destroyed", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);
      const obj = gameObjectOf(child);
      const rotation = child.get(Rotation);
      // An in-place write to the dying child's Rotation would now throw.
      Object.freeze(rotation);
      const set = vi.spyOn(child, "set");
      const modified = vi.spyOn(child, "modified");

      expect(() => {
        child.destroy();
        world.progress(1, 16);
      }).not.toThrow();

      expect(child.destroyed).toBe(true);
      expect(obj.destroyed).toBe(true);
      expect(set).not.toHaveBeenCalled();
      expect(modified).not.toHaveBeenCalled();
      // Not rewritten to the tag's own angle.
      expect(rotation?.angle).toBeCloseTo(HALF_PI + 0.25, 9);
      expectPose(parent, { x: 1, y: 2, angle: HALF_PI });
    });

    it("writes nothing to a tagged parent that is destroyed, and its child keeps its last pose", () => {
      const { world } = setup();
      const root = spawnParent(world, 1, 1, HALF_PI);
      const middle = spawnChild(world, root, { offset: { x: 2, y: 1 }, tag: 0.25 });
      const leaf = spawnChild(world, middle, { offset: { x: 1, y: 2 }, tag: 0.5 });
      world.progress(0, 0);
      const leafPose = {
        x: leaf.get(Position)?.x,
        y: leaf.get(Position)?.y,
        angle: leaf.get(Rotation)?.angle,
      };
      const middleRotation = middle.get(Rotation);
      Object.freeze(middleRotation);
      const set = vi.spyOn(middle, "set");
      const modified = vi.spyOn(middle, "modified");

      expect(() => {
        middle.destroy();
        world.progress(1, 16);
        root.set(Rotation, { angle: Math.PI });
        world.progress(2, 16);
      }).not.toThrow();

      expect(set).not.toHaveBeenCalled();
      expect(modified).not.toHaveBeenCalled();
      expect(middleRotation?.angle).toBeCloseTo(HALF_PI + 0.25, 9);
      // DrawBy is removed with the parent, so the leaf is out of the resolver and stays put.
      expect(leaf.has(DrawBy)).toBe(false);
      expect(leaf.has(InheritRotation)).toBe(true);
      expectPose(leaf, leafPose);
    });

    it("leaves a child on its last pose when its parent is destroyed", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);
      const obj = gameObjectOf(child);
      Object.freeze(parent.get(Position));
      Object.freeze(parent.get(Rotation));

      expect(() => {
        parent.destroy();
        world.progress(1, 16);
        world.progress(2, 16);
      }).not.toThrow();

      expect(child.has(DrawBy)).toBe(false);
      expect(child.has(InheritRotation)).toBe(true);
      expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });
      expectRendered(obj, { x: 0, y: 4, angle: HALF_PI + 0.25 });
      expect(obj.destroyed).toBe(false);
    });

    it("writes nothing to any entity when the world is cleared", () => {
      const { world } = setup();
      const parent = spawnParent(world, 1, 2, HALF_PI);
      const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25 });
      world.progress(0, 0);
      // An in-place write to the dying child's Rotation would now throw.
      Object.freeze(child.get(Rotation));
      const set = vi.spyOn(child, "set");
      const modified = vi.spyOn(child, "modified");

      expect(() => world.clearAllEntities()).not.toThrow();

      expect(child.destroyed).toBe(true);
      expect(set).not.toHaveBeenCalled();
      expect(modified).not.toHaveBeenCalled();
    });
  });
});
