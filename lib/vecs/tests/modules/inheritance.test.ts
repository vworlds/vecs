import { describe, expect, it } from "vitest";
import {
  DontInherit,
  Exclusive,
  Inherit,
  IsA,
  OnInstantiate,
  OneOf,
  Override,
  Relationship,
  World,
} from "../../src/index.js";

class Helmet {
  armor = 0;
}
class Sword extends Relationship {}

describe("InheritanceModule (Phase 3 skeleton)", () => {
  it("is auto-registered by new World()", () => {
    const w = new World();
    expect(() => w.component(IsA)).not.toThrow();
    expect(() => w.component(OnInstantiate)).not.toThrow();
    expect(w.component(IsA).meta.isRelationship).toBe(true);
    expect(w.component(OnInstantiate).meta.isRelationship).toBe(true);
  });

  it("configures OnInstantiate as a OneOf self-parent", () => {
    const w = new World();
    const onInstantiate = w.component(OnInstantiate);
    expect(onInstantiate.has(OneOf)).toBe(true);
    expect(onInstantiate.target(OneOf)).toBe(onInstantiate);
  });

  it("creates Override, Inherit, DontInherit as children of OnInstantiate", () => {
    const w = new World();
    const onInstantiate = w.component(OnInstantiate);
    expect(Override.parent).toBe(onInstantiate);
    expect(Inherit.parent).toBe(onInstantiate);
    expect(DontInherit.parent).toBe(onInstantiate);
    void Override;
  });

  it("supports add(OnInstantiate, Inherit) and resolves the target", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    helmet.add(OnInstantiate, Inherit);
    expect(helmet.target(OnInstantiate)).toBe(Inherit);
  });

  it("rejects an OnInstantiate target that is not a child of OnInstantiate", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    const randomEntity = w.entity();
    expect(() => helmet.add(OnInstantiate, randomEntity)).toThrow("OneOf: target");
  });

  it("marks IsA as Exclusive", () => {
    const w = new World();
    expect(w.component(IsA).has(Exclusive)).toBe(true);
  });

  it("silently replaces the IsA target on a second add (retarget guard is Phase 5)", () => {
    const w = new World();
    const t1 = w.entity();
    const t2 = w.entity();
    const e = w.entity().add(IsA, t1);
    expect(e.target(IsA)).toBe(t1);
    e.add(IsA, t2);
    expect(e.target(IsA)).toBe(t2);
  });

  it("allows clearAllEntities to tear down a world with OnInstantiate configured", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    helmet.add(OnInstantiate, Inherit);
    w.entity().add(IsA, w.entity());
    expect(() => w.clearAllEntities()).not.toThrow();
    expect(w.entities.size).toBe(0);
  });
});
