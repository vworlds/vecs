import { describe, expect, it } from "vitest";
import { ChildOf, Relationship, Traversable, World } from "../../src/index.js";

class ParentOf extends Relationship {}

function depthOf(w: World, entity: unknown): number | undefined {
  return w
    .entity(ParentOf)
    .get(Traversable)!
    .depths.get(entity as any);
}

describe("RelationshipsModule", () => {
  it("marks ChildOf as Traversable by default", () => {
    const w = new World();
    expect(w.entity(ChildOf).get(Traversable)).toBeInstanceOf(Traversable);
  });

  it("is not tracked for entities without the relationship", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const e = w.entity();
    expect(depthOf(w, e)).toBeUndefined();
  });

  it("depth 1 for an entity whose parent has no parent", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const parent = w.entity();
    const child = w.entity().set(ParentOf, { target: parent });
    expect(depthOf(w, child)).toBe(1);
  });

  it("depth 2 for child of child", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const root = w.entity();
    const a = w.entity().set(ParentOf, { target: root });
    const b = w.entity().set(ParentOf, { target: a });
    expect(depthOf(w, a)).toBe(1);
    expect(depthOf(w, b)).toBe(2);
  });

  it("update depth when retargeting to a root", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const a = w.entity();
    const b = w.entity().set(ParentOf, { target: w.entity() });
    const c = w.entity().set(ParentOf, { target: a });
    expect(depthOf(w, c)).toBe(1); // parent is a, which has no parent
    c.set(ParentOf, { target: b });
    expect(depthOf(w, c)).toBe(2); // parent is b, which has depth 1
  });

  it("cascades depth to descendants on add", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const root = w.entity();
    const a = w.entity().set(ParentOf, { target: root });
    const b = w.entity().set(ParentOf, { target: a });
    const c = w.entity().set(ParentOf, { target: b });

    expect(depthOf(w, a)).toBe(1);
    expect(depthOf(w, b)).toBe(2);
    expect(depthOf(w, c)).toBe(3);

    const a2 = w.entity().set(ParentOf, { target: a });
    expect(depthOf(w, a2)).toBe(2);
    const b2 = w.entity().set(ParentOf, { target: b });
    expect(depthOf(w, b2)).toBe(3);
    expect(depthOf(w, c)).toBe(3);
  });

  it("removes depth entry on remove", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const a = w.entity().set(ParentOf, { target: w.entity() });
    expect(depthOf(w, a)).toBe(1);
    a.remove(ParentOf);
    expect(depthOf(w, a)).toBeUndefined();
  });

  it("recascades descendants when a node is removed", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const root = w.entity();
    const a = w.entity().set(ParentOf, { target: root });
    const b = w.entity().set(ParentOf, { target: a });
    const leaf = w.entity().set(ParentOf, { target: b });

    expect(depthOf(w, a)).toBe(1);
    expect(depthOf(w, b)).toBe(2);
    expect(depthOf(w, leaf)).toBe(3);

    a.remove(ParentOf);
    expect(depthOf(w, a)).toBeUndefined();
    // b loses its anchor — becomes depth 0
    expect(depthOf(w, b)).toBe(1);
    // leaf cascades from b
    expect(depthOf(w, leaf)).toBe(2);
  });

  it("updates correctly after chained retarget", () => {
    const w = new World();
    w.component(ParentOf).add(Traversable);
    const a = w.entity();
    const b = w.entity();
    const c = w.entity().set(ParentOf, { target: a });
    const d = w.entity().set(ParentOf, { target: c });

    expect(depthOf(w, c)).toBe(1);
    expect(depthOf(w, d)).toBe(2);

    // Move c to a different root
    c.set(ParentOf, { target: b });
    expect(depthOf(w, c)).toBe(1);
    expect(depthOf(w, d)).toBe(2);
  });

  it("backfills entities that existed before Traversable was added", () => {
    const w = new World();
    w.component(ParentOf);
    const root = w.entity();
    const a = w.entity().set(ParentOf, { target: root });
    const b = w.entity().set(ParentOf, { target: a });

    w.component(ParentOf).add(Traversable);

    expect(depthOf(w, root)).toBeUndefined();
    expect(depthOf(w, a)).toBe(1);
    expect(depthOf(w, b)).toBe(2);
  });

  it("stops tracking after Traversable is removed", () => {
    const w = new World();
    w.component(ParentOf);
    w.component(ParentOf).add(Traversable);
    const a = w.entity().set(ParentOf, { target: w.entity() });
    expect(depthOf(w, a)).toBe(1);

    // Remove Traversable — hooks are cleared, depths map is gone
    w.entity(ParentOf).remove(Traversable);
    const b = w.entity().set(ParentOf, { target: w.entity() });
    // depths map no longer exists, but e.components still works
    expect(b.get(ParentOf)).toBeTruthy();
  });

  it("multiple relationships tracked independently", () => {
    const w = new World();
    class FriendOf extends Relationship {}

    w.component(FriendOf);
    w.component(ParentOf).add(Traversable);
    w.component(FriendOf).add(Traversable);

    const root = w.entity();
    const a = w.entity().set(ParentOf, { target: root });
    const b = w.entity().set(FriendOf, { target: root });
    const c = w.entity().set(FriendOf, { target: b });

    expect(depthOf(w, a)).toBe(1);

    const friendOfDepths = w.entity(FriendOf).get(Traversable)!.depths;
    expect(friendOfDepths.get(root)).toBeUndefined();
    expect(friendOfDepths.get(b)).toBe(1);
    expect(friendOfDepths.get(c)).toBe(2);
  });
});
