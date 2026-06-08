import { describe, expect, it } from "vitest";
import {
  BUILTIN_PIPELINE_PHASES,
  Component,
  DEFAULT_ID_REUSE_WAIT_FRAMES,
  DependsOn,
  insertPhaseAfter,
  Module,
  ON_UPDATE,
  ON_VALIDATE,
  Phase,
  PRE_STORE,
  World,
} from "../src/index.js";
import { makePhase } from "./_helpers.js";

class A {}
class B {}
class Settings {
  enabled = false;
  limit = 0;
}

describe("World - id pools", () => {
  it("uses default component, module, and entity pools", () => {
    const w = new World();
    const nextComponentEid = w.peekNextEid("component");
    const nextModuleEid = w.peekNextEid("module");
    const nextEntityEid = w.peekNextEid("entity");

    class TestModule extends Module {
      public init(): void {}
    }

    expect(nextComponentEid).toBeGreaterThanOrEqual(1);
    expect(nextComponentEid).toBeLessThanOrEqual(899);
    expect(nextModuleEid).toBeGreaterThanOrEqual(900);
    expect(nextModuleEid).toBeLessThanOrEqual(999);
    expect(nextEntityEid).toBeGreaterThanOrEqual(1000);
    expect(w.component(A).eid).toBe(nextComponentEid);
    expect(w.module(TestModule).eid).toBe(nextModuleEid);
    expect(w.entity().eid).toBe(nextEntityEid);
  });

  it("rejects eid 0 for explicit component, module, and entity creation", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const w = new World();

    expect(() => w.component(A, 0)).toThrow();
    expect(() => w.module(TestModule, 0)).toThrow();
    expect(() => w.getOrCreateEntity(0)).toThrow();
  });

  it("accepts complete pool partitions", () => {
    const w = new World({
      idPools: [
        { name: "network", min: 1, max: 255 },
        { name: "component", min: 256, max: 899 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });

    const nextComponentEid = w.peekNextEid("component");
    const nextModuleEid = w.peekNextEid("module");
    const nextEntityEid = w.peekNextEid("entity");

    class TestModule extends Module {
      public init(): void {}
    }

    expect(nextComponentEid).toBeGreaterThanOrEqual(256);
    expect(nextComponentEid).toBeLessThanOrEqual(899);
    expect(nextModuleEid).toBeGreaterThanOrEqual(900);
    expect(nextModuleEid).toBeLessThanOrEqual(999);
    expect(nextEntityEid).toBeGreaterThanOrEqual(1000);
    expect(w.component(A).eid).toBe(nextComponentEid);
    expect(w.module(TestModule).eid).toBe(nextModuleEid);
    expect(w.entity().eid).toBe(nextEntityEid);
  });

  it("rejects invalid pool partitions", () => {
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "module", min: 11, max: 20 },
            { name: "entity", min: 22 },
          ],
        })
    ).toThrow();
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "component", min: 11, max: 20 },
            { name: "module", min: 21, max: 30 },
            { name: "entity", min: 31 },
          ],
        })
    ).toThrow();
    expect(() => new World({ idPools: [{ name: "component", min: 1 }] })).toThrow();
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "module", min: 11, max: 20 },
            { name: "entity", min: 21, max: 30 },
          ],
        })
    ).toThrow();
    expect(
      () =>
        new World({
          idPools: [
            { name: "component", min: 1, max: 10 },
            { name: "module", min: 11, max: 20 },
            { name: "entity", min: 21, reuseWaitFrames: -1 },
          ],
        })
    ).toThrow();
  });

  it("bakes pool configuration into the constructor", () => {
    const w = new World({
      idPools: [
        { name: "component", min: 1, max: 999 },
        { name: "module", min: 1000, max: 1999 },
        { name: "entity", min: 2000 },
      ],
    });
    const nextComponentEid = w.peekNextEid("component");
    const nextModuleEid = w.peekNextEid("module");
    const nextEntityEid = w.peekNextEid("entity");

    class TestModule extends Module {
      public init(): void {}
    }

    expect(w.component(A).eid).toBe(nextComponentEid);
    expect(w.module(TestModule).eid).toBe(nextModuleEid);
    expect(w.entity().eid).toBe(nextEntityEid);
    expect("configurePools" in w).toBe(false);
  });

  it("returns destroyed ids to their pools after the reuse wait", () => {
    const w = new World();
    const nextEntityEid = w.peekNextEid("entity");
    const a = w.entity();
    const b = w.entity();

    a.destroy();

    expect(w.entity().eid).toBe(nextEntityEid + 2);
    for (let i = 0; i < DEFAULT_ID_REUSE_WAIT_FRAMES; i++) {
      w.progress(0, 0);
    }
    expect(w.entity().eid).toBe(a.eid);
    expect(b.eid).toBe(nextEntityEid + 1);
  });
});

describe("World - entity management", () => {
  it("getEntity(id) returns the entity or undefined", () => {
    const w = new World();
    const e = w.entity();

    expect(w.getEntity(e.eid)).toBe(e);
    expect(w.getEntity(999)).toBeUndefined();
    expect(() => w.getEntity(0)).toThrow(/reserved/);
  });

  it("entity(id) returns the entity or throws", () => {
    const w = new World();
    const e = w.entity();

    expect(w.entity(e.eid)).toBe(e);
    expect(() => w.entity(999)).toThrow();
    expect(() => w.entity(0)).toThrow(/reserved/);
  });

  it("getEntity(ref) resolves component classes and entity refs", () => {
    const w = new World();
    const component = w.component(A);
    const e = w.entity();

    expect(w.getEntity(A)).toBe(component);
    expect(w.getEntity(e)).toBe(e);
  });

  it("entity(ref) resolves component classes and entity refs", () => {
    const w = new World();
    const component = w.component(A);
    const e = w.entity();

    expect(w.entity(A)).toBe(component);
    expect(w.entity(e)).toBe(e);
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
    const eid = w.peekNextEid("entity");
    let created = 0;

    w.getOrCreateEntity(eid, () => created++);
    w.getOrCreateEntity(eid, () => created++);

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

    expect(() => w.entity(component.eid)).toThrow();
    expect(() => w.entity(e1.eid)).toThrow();
    expect(() => w.entity(e2.eid)).toThrow();
  });
});

describe("World - components", () => {
  it("creates component entities and metadata", () => {
    const w = new World();
    const component = w.component(A);

    expect(component).toBeInstanceOf(Component);
    expect(w.entity(component.eid)).toBe(component);
    expect(component.meta.eid).toBe(component.eid);
  });

  it("reserves explicit component eids in any pool", () => {
    const w = new World();
    const nextEntityEid = w.peekNextEid("entity");

    expect(w.component(A, 1200).eid).toBe(1200);
    expect(w.entity().eid).toBe(nextEntityEid);
  });

  it("is idempotent for the same class and same eid", () => {
    const w = new World();
    const component = w.component(A, 50);

    expect(w.component(A, 50)).toBe(component);
  });

  it("throws for a taken eid with a different class", () => {
    const w = new World();
    w.component(A, 50);

    expect(() => w.component(B, 50)).toThrow();
  });

  it("throws for the same class at a different eid", () => {
    const w = new World();
    w.component(A, 50);

    expect(() => w.component(A, 51)).toThrow();
  });

  it("lazily creates Object metadata for entity refs", () => {
    const w = new World();
    const e = w.entity();

    expect(e.meta.Class).toBe(Object);
    expect(e.meta.eid).toBe(e.eid);
  });

  it("throws for missing numeric component refs", () => {
    const w = new World();
    const e = w.entity();

    expect(() => e.add(42)).toThrow(/No entity with eid 42/);
  });

  it("component APIs throw for unregistered component classes", () => {
    const w = new World();
    const e = w.entity();

    expect(() => e.add(A)).toThrow();
    expect(() => e.set(A, {})).toThrow();
    expect(() => e.modified(A)).toThrow();
    expect(() => w.system("test").with(A)._build()).toThrow();
  });

  it("gets component-owned instances", () => {
    const w = new World();

    expect(w.get(Settings)).toBeUndefined();
    expect(w.component(Settings).meta.Class).toBe(Settings);
  });

  it("sets component-owned instances", () => {
    const w = new World();

    const component = w.set(Settings, { enabled: true, limit: 3 });

    expect(component).toBe(w.component(Settings));
    expect(w.get(Settings)).toMatchObject({ enabled: true, limit: 3 });
    expect(w.component(Settings).get(Settings)).toBe(w.get(Settings));
  });
});

describe("World - pipeline", () => {
  it("creates namespaced built-in phase entities", () => {
    const w = new World();

    for (const name of BUILTIN_PIPELINE_PHASES) {
      expect(w.entity(name).has(Phase)).toBe(true);
    }
  });

  it("chains built-in phases with DependsOn", () => {
    const w = new World();

    for (let i = 1; i < BUILTIN_PIPELINE_PHASES.length; i++) {
      expect(w.entity(BUILTIN_PIPELINE_PHASES[i]).parent(DependsOn)).toBe(
        w.entity(BUILTIN_PIPELINE_PHASES[i - 1])
      );
    }
  });

  it("registers new component classes after start", () => {
    const w = new World();
    w.start();

    const component = w.component(A);

    expect(component).toBeInstanceOf(Component);
    expect(w.component(A)).toBe(component);
  });

  it("progress runs systems in dependency order", () => {
    const w = new World();
    const order: string[] = [];
    const pre = makePhase(w, "pre");
    const update = makePhase(w, "update", pre);
    const post = makePhase(w, "post", update);

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

  it("insertPhaseAfter splices phase children without moving anchor systems", () => {
    const w = new World();
    const inserted = w.entity("inserted").add(Phase);
    const seen: string[] = [];
    const update = w
      .system("update")
      .phase(ON_UPDATE)
      .run(() => seen.push("update"));
    w.system("inserted")
      .phase(inserted)
      .run(() => seen.push("inserted"));
    w.system("validate")
      .phase(ON_VALIDATE)
      .run(() => seen.push("validate"));

    insertPhaseAfter(inserted, w.entity(ON_UPDATE));

    expect(update.entity.parent(DependsOn)).toBe(w.entity(ON_UPDATE));
    expect(inserted.parent(DependsOn)).toBe(w.entity(ON_UPDATE));
    expect(w.entity(ON_VALIDATE).parent(DependsOn)).toBe(inserted);

    w.start();
    w.progress(0, 0);

    expect(seen).toEqual(["update", "inserted", "validate"]);
  });

  it("insertPhaseAfter removes same-depth ties with later built-in phases", () => {
    const w = new World();
    const pre = w.entity("pre").add(Phase);
    const step = w.entity("step").add(Phase);
    const post = w.entity("post").add(Phase);
    const seen: string[] = [];

    w.system("collect")
      .phase(PRE_STORE)
      .run(() => seen.push("collect"));
    insertPhaseAfter(pre, w.entity(ON_UPDATE));
    insertPhaseAfter(step, pre);
    insertPhaseAfter(post, step);
    w.system("post")
      .phase(post)
      .run(() => seen.push("post"));

    w.start();
    w.progress(0, 0);

    expect(seen).toEqual(["post", "collect"]);
  });

  it("insertPhaseAfter requires the inserted entity to be a phase", () => {
    const w = new World();
    const loose = w.entity("loose");

    expect(() => insertPhaseAfter(loose, w.entity(ON_UPDATE))).toThrow(/Phase/);
  });

  it("setPipeline replaces which systems the world runs", () => {
    class InPipeline {}
    const w = new World();
    w.component(InPipeline);
    const seen: string[] = [];

    w.system("a")
      .run(() => seen.push("a"))
      .entity.add(InPipeline);
    w.system("b").run(() => seen.push("b")); // not tagged — excluded by the custom spec

    // World appends `System`, so the spec only needs to select the tagged entities.
    w.setPipeline(InPipeline);
    w.start();
    w.progress(0, 0);

    expect(seen).toEqual(["a"]);
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
