import { describe, expect, it } from "vitest";
import { Component, Identity, IdentityModule, World } from "../src/index.js";

class A {}
class B {}

describe("World - id pools", () => {
  it("uses default component and entity pools", () => {
    const w = new World();

    expect(w.getComponentMeta(IdentityModule).eid).toBe(1);
    expect(w.getComponentMeta(Identity).eid).toBe(2);
    expect(w.component(A).eid).toBe(3);
    expect(w.entity().eid).toBe(1000);
  });

  it("rejects eid 0 for explicit component and entity creation", () => {
    const w = new World();

    expect(() => w.component(A, 0)).toThrow();
    expect(() => w.getOrCreateEntity(0)).toThrow();
  });

  it("accepts complete pool partitions", () => {
    const w = new World({
      idPools: [
        { name: "network", min: 1, max: 255 },
        { name: "component", min: 256, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });

    expect(w.getComponentMeta(IdentityModule).eid).toBe(256);
    expect(w.getComponentMeta(Identity).eid).toBe(257);
    expect(w.component(A).eid).toBe(258);
    expect(w.entity().eid).toBe(1000);
  });

  it("rejects invalid pool partitions", () => {
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "entity", min: 12 },
          ],
        })
    ).toThrow();
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "component", min: 11, max: 20 },
            { name: "entity", min: 21 },
          ],
        })
    ).toThrow();
    expect(() => new World({ idPools: [{ name: "component", min: 1 }] })).toThrow();
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "entity", min: 11, max: 20 },
          ],
        })
    ).toThrow();
  });

  it("bakes pool configuration into the constructor", () => {
    const w = new World({
      idPools: [
        { name: "component", min: 1, max: 9 },
        { name: "entity", min: 10 },
      ],
    });

    expect(w.component(A).eid).toBe(3);
    expect(w.entity().eid).toBe(10);
    expect("configurePools" in w).toBe(false);
  });

  it("returns destroyed ids to their pools and reuses the lowest id", () => {
    const w = new World();
    const a = w.entity();
    const b = w.entity();

    a.destroy();

    expect(w.entity().eid).toBe(a.eid);
    expect(b.eid).toBe(1001);
  });
});

describe("World - entity management", () => {
  it("entity(id) returns the entity or undefined", () => {
    const w = new World();
    const e = w.entity();

    expect(w.entity(e.eid)).toBe(e);
    expect(w.entity(999)).toBeUndefined();
  });

  it("getOrCreateEntity returns existing entity or creates a new one", () => {
    const w = new World();
    const a = w.getOrCreateEntity(42);
    const b = w.getOrCreateEntity(42);

    expect(a).toBe(b);
    expect(a.eid).toBe(42);
  });

  it("getOrCreateEntity invokes the create callback only on first creation", () => {
    const w = new World();
    let created = 0;

    w.getOrCreateEntity(7, () => created++);
    w.getOrCreateEntity(7, () => created++);

    expect(created).toBe(1);
  });

  it("clearAllEntities destroys ordinary entities before component entities", () => {
    const w = new World();
    const component = w.component(A);
    const e1 = w.entity();
    const e2 = w.entity();
    e1.add(A);
    e2.add(A);

    w.clearAllEntities();

    expect(w.entity(component.eid)).toBeUndefined();
    expect(w.entity(e1.eid)).toBeUndefined();
    expect(w.entity(e2.eid)).toBeUndefined();
  });
});

describe("World - components", () => {
  it("creates component entities and metadata", () => {
    const w = new World();
    const component = w.component(A);

    expect(component).toBeInstanceOf(Component);
    expect(w.entity(component.eid)).toBe(component);
    expect(w.getComponentMeta(A).eid).toBe(component.eid);
  });

  it("reserves explicit component eids in any pool", () => {
    const w = new World();

    expect(w.component(A, 1200).eid).toBe(1200);
    expect(w.entity().eid).toBe(1000);
  });

  it("is idempotent for the same class and same eid", () => {
    const w = new World();
    const component = w.component(A, 5);

    expect(w.component(A, 5)).toBe(component);
  });

  it("throws for a taken eid with a different class", () => {
    const w = new World();
    w.component(A, 5);

    expect(() => w.component(B, 5)).toThrow();
  });

  it("throws for the same class at a different eid", () => {
    const w = new World();
    w.component(A, 5);

    expect(() => w.component(A, 6)).toThrow();
  });

  it("lazily creates Object metadata for numeric and entity refs", () => {
    const w = new World();
    const e = w.entity();

    expect(w.getComponentMeta(42).Class).toBe(Object);
    expect(w.getComponentMeta(e).eid).toBe(e.eid);
  });

  it("component APIs throw for unregistered component classes", () => {
    const w = new World();
    const e = w.entity();

    expect(() => e.add(A)).toThrow();
    expect(() => e.set(A, {})).toThrow();
    expect(() => e.modified(A)).toThrow();
    expect(() => w.system("test").requires(A)._build()).toThrow();
  });
});

describe("World - phases", () => {
  it("addPhase returns an IPhase keyed by name", () => {
    const w = new World();
    const p = w.addPhase("preupdate");

    expect(p.name).toBe("preupdate");
    expect(p.world).toBe(w);
  });

  it("hook returns the same ComponentMeta object", () => {
    const w = new World();
    w.component(A);

    expect(w.hook(A)).toBe(w.hook(A));
  });

  it("progress runs all phases in insertion order", () => {
    const w = new World();
    const order: string[] = [];
    const pre = w.addPhase("pre");
    const update = w.addPhase("update");
    const post = w.addPhase("post");

    w.system("s1")
      .phase(pre)
      .run(() => order.push("pre"));
    w.system("s2")
      .phase(update)
      .run(() => order.push("update"));
    w.system("s3")
      .phase(post)
      .run(() => order.push("post"));
    w.start();
    w.progress(0, 16);

    expect(order).toEqual(["pre", "update", "post"]);
  });

  it("runPhase outside a frame throws", () => {
    const w = new World();
    const phase = w.addPhase("update");

    expect(() => w.runPhase(phase, 0, 16)).toThrow();
  });

  it("beginFrame without prior endFrame throws", () => {
    const w = new World();

    w.beginFrame(0);
    expect(() => w.beginFrame(0)).toThrow();
    w.endFrame();
  });

  it("endFrame without prior beginFrame throws", () => {
    const w = new World();

    expect(() => w.endFrame()).toThrow();
  });

  it("progress closes the frame when a phase throws", () => {
    const w = new World();
    w.system("boom").run(() => {
      throw new Error("boom");
    });
    w.start();

    expect(() => w.progress(0, 0)).toThrow("boom");
    expect((w as any)._frameInProgress).toBe(false);
  });
});
