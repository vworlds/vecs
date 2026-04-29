import { describe, it, expect } from "vitest";
import { World, Component } from "../src/index.js";

class A extends Component {}
class B extends Component {}

describe("World — entity management", () => {
  it("entity() assigns sequential ids starting at 0", () => {
    const w = new World();
    const a = w.entity();
    const b = w.entity();
    expect(a.eid).toBe(0);
    expect(b.eid).toBe(1);
    expect(a.world).toBe(w);
  });

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

  it("setEntityIdRange shifts the auto-incrementing counter", () => {
    const w = new World();
    w.setEntityIdRange(1000);
    expect(w.entity().eid).toBe(1000);
    expect(w.entity().eid).toBe(1001);
  });

  it("setEntityIdRange after start() throws", () => {
    const w = new World();
    w.start();
    expect(() => w.setEntityIdRange(1000)).toThrow();
  });

  it("setEntityIdRange before start() works even if components are registered", () => {
    const w = new World();
    w.registerComponent(A);
    w.setEntityIdRange(500);
    expect(w.entity().eid).toBe(500);
  });

  it("clearAllEntities destroys every entity", () => {
    const w = new World();
    w.registerComponent(A);
    const e1 = w.entity();
    const e2 = w.entity();
    e1.add(A);
    e2.add(A);
    w.clearAllEntities();
    expect(w.entity(e1.eid)).toBeUndefined();
    expect(w.entity(e2.eid)).toBeUndefined();
  });
});

describe("World — component registration", () => {
  it("auto-assigns local type ids starting at 256", () => {
    const w = new World();
    w.registerComponent(A);
    expect(w.getComponentType(A)).toBe(256);
    w.registerComponent(B);
    expect(w.getComponentType(B)).toBe(257);
  });

  it("accepts an explicit numeric type id", () => {
    const w = new World();
    w.registerComponent(A, 5);
    expect(w.getComponentType(A)).toBe(5);
  });

  it("accepts a custom display name", () => {
    const w = new World();
    w.registerComponent(A, "Apple");
    expect(w.getComponentMeta(A).componentName).toBe("Apple");
  });

  it("accepts both an explicit type id and a name", () => {
    const w = new World();
    w.registerComponent(A, 9, "Apple");
    expect(w.getComponentType(A)).toBe(9);
    expect(w.getComponentMeta(A).componentName).toBe("Apple");
  });

  it("uses pre-registered name→type mapping when present", () => {
    const w = new World();
    w.registerComponentType("A", 10);
    w.registerComponent(A);
    expect(w.getComponentType(A)).toBe(10);
  });

  it("throws when a class is registered twice", () => {
    const w = new World();
    w.registerComponent(A);
    expect(() => w.registerComponent(A)).toThrow();
  });

  it("registration is disabled after start()", () => {
    const w = new World();
    w.registerComponent(A);
    w.start();
    expect(() => w.registerComponent(B)).toThrow();
  });

  it("disableComponentRegistration locks registration without starting", () => {
    const w = new World();
    w.registerComponent(A);
    w.disableComponentRegistration();
    expect(() => w.registerComponent(B)).toThrow();
  });

  it("getComponentType passes through numeric ids unchanged", () => {
    const w = new World();
    w.registerComponent(A, 99);
    expect(w.getComponentType(99)).toBe(99);
  });

  it("getComponentMeta throws for an unknown type", () => {
    const w = new World();
    expect(() => w.getComponentMeta(A)).toThrow();
    expect(() => w.getComponentMeta(123)).toThrow();
  });
});

describe("World — phases", () => {
  it("addPhase returns an IPhase keyed by name", () => {
    const w = new World();
    const p = w.addPhase("preupdate");
    expect(p.name).toBe("preupdate");
    expect(p.world).toBe(w);
  });

  it("hook returns the same ComponentMeta object", () => {
    const w = new World();
    w.registerComponent(A);
    const h1 = w.hook(A);
    const h2 = w.hook(A);
    expect(h1).toBe(h2);
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
});
