import { describe, expect, it } from "vitest";
import { OneOf, Relationship, World } from "../../src/index.js";

class AlignedWith extends Relationship {}
class Alignment extends Relationship {}
class ResidesIn extends Relationship {}
class Region extends Relationship {}
class NotRelationship {}

describe("OneOf trait", () => {
  it("accepts a target that is a direct child of the declared parent", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    const forest = w.entity().childOf(region);

    const e = w.entity().add(ResidesIn, forest);

    expect(e.hasTarget(ResidesIn, forest)).toBe(true);
  });

  it("rejects a target whose ChildOf parent is not the declared parent", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    const weather = w.entity();
    // weather has no parent at all.
    const e = w.entity();

    expect(() => e.add(ResidesIn, weather)).toThrow("OneOf: target");
    // Invariant violation: the edge is partially routed when the policy hook
    // throws. The world is left partially mutated; discard it.
  });

  it("rejects a target that is a child of a different parent", () => {
    const w = new World();
    const region = w.component(Region);
    const sky = w.entity();
    w.component(ResidesIn).add(OneOf, region);
    const cloud = w.entity().childOf(sky);

    const e = w.entity();
    expect(() => e.add(ResidesIn, cloud)).toThrow("OneOf: target");
    // World partially mutated; discard it.
  });

  it("supports the self/enum form when the relationship is its own parent", () => {
    const w = new World();
    const alignment = w.component(Alignment);
    // Self form: targets of Alignment must be children of Alignment itself.
    alignment.add(OneOf, alignment);
    const good = w.entity().childOf(alignment);

    const e = w.entity().add(Alignment, good);

    expect(e.hasTarget(Alignment, good)).toBe(true);
  });

  it("rejects a self-form target that is not a child of the relationship", () => {
    const w = new World();
    const alignment = w.component(Alignment);
    alignment.add(OneOf, alignment);
    const weather = w.entity();

    expect(() => w.entity().add(Alignment, weather)).toThrow("OneOf: target");
    // World partially mutated; discard it.
  });

  it("can only be added to a Relationship component", () => {
    const w = new World();
    const notRel = w.component(NotRelationship);
    const region = w.entity();

    expect(() => notRel.add(OneOf, region)).toThrow(
      "OneOf can only be added to a Relationship component"
    );
    // World partially mutated; discard it.
  });

  it("rejects being attached while the relationship is already in use", () => {
    const w = new World();
    const residesIn = w.component(ResidesIn);
    const region = w.component(Region);
    const forest = w.entity().childOf(region);
    // Put an edge in flight so ResidesIn is in use.
    w.entity().add(ResidesIn, forest);

    expect(() => residesIn.add(OneOf, region)).toThrow("in use");
    // World partially mutated; discard it.
  });

  it("is idempotent: re-adding OneOf to the same parent does not throw", () => {
    const w = new World();
    const region = w.component(Region);
    const residesIn = w.component(ResidesIn).add(OneOf, region);

    expect(() => residesIn.add(OneOf, region)).not.toThrow();
    expect(residesIn.hasTarget(OneOf, region)).toBe(true);
  });

  it("is irrevocable: removing OneOf throws", () => {
    const w = new World();
    const region = w.component(Region);
    const residesIn = w.component(ResidesIn).add(OneOf, region);

    expect(() => residesIn.remove(OneOf, region)).toThrow("OneOf cannot be removed");
    // World partially mutated; discard it.
  });

  it("surfaces invalid target adds at flush() in deferred mode", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    const weather = w.entity();
    const e = w.entity();

    w.beginDefer();
    expect(() => e.add(ResidesIn, weather)).not.toThrow();
    // In deferred mode the edge is not yet routed; the validation hook runs
    // during the command queue drain.
    expect(e.hasTarget(ResidesIn, weather)).toBe(false);
    expect(() => w.endDefer()).toThrow("OneOf: target");
    // World partially mutated; discard it.
  });

  it("surfaces invalid OneOf attach at flush() in deferred mode", () => {
    const w = new World();
    w.component(ResidesIn);
    const region = w.component(Region);
    const forest = w.entity().childOf(region);
    w.entity().add(ResidesIn, forest); // ResidesIn is now in use.

    w.beginDefer();
    expect(() => w.component(ResidesIn).add(OneOf, region)).not.toThrow();
    expect(w.component(ResidesIn).has(OneOf)).toBe(false);
    expect(() => w.endDefer()).toThrow("in use");
    // World partially mutated; discard it.
  });

  it("validates edges added in deferred mode only after the queue drains", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    const forest = w.entity().childOf(region);
    const e = w.entity();

    w.beginDefer();
    e.add(ResidesIn, forest);
    expect(e.hasTarget(ResidesIn, forest)).toBe(false);
    w.endDefer();

    expect(e.hasTarget(ResidesIn, forest)).toBe(true);
  });

  it("clearAllEntities tears down worlds with OneOf configured and live edges", () => {
    const w = new World();
    const region = w.component(Region);
    const residesIn = w.component(ResidesIn).add(OneOf, region);
    const forest = w.entity().childOf(region);
    const e = w.entity().add(ResidesIn, forest);
    expect(e.hasTarget(ResidesIn, forest)).toBe(true);

    // Teardown bypasses _onPolicyRemove (Entity._destroy routes the OneOf
    // pair through _detachRelationship, which does not call _onPolicyRemove),
    // so the irrevocability guard never fires during world destruction. The
    // targetPolicyRemove guard also short-circuits when either side is
    // destroyed (relationships.ts teardown path).
    expect(() => w.clearAllEntities()).not.toThrow();
    expect(w.entities.size).toBe(0);
    void residesIn;
  });

  it("does not affect edges added through a different relationship", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);

    class KnowsOf extends Relationship {}
    const knowsOf = w.component(KnowsOf);
    const weather = w.entity();

    // OneOf only constrains ResidesIn; KnowsOf is unconstrained.
    const e = w.entity().add(KnowsOf, weather);
    expect(e.hasTarget(KnowsOf, weather)).toBe(true);
    void knowsOf;
  });

  it("checks the ChildOf parent, not transitive ancestors", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    // glade is a descendant of Region via an intermediate, not a direct child.
    const forest = w.entity().childOf(region);
    const glade = w.entity().childOf(forest);

    expect(() => w.entity().add(ResidesIn, glade)).toThrow("OneOf: target");
    // World partially mutated; discard it.
  });

  it("validates the parent argument belongs to the same world", () => {
    const w = new World();
    const region = w.component(Region);
    w.component(ResidesIn).add(OneOf, region);
    // Cross-world target rejection is enforced by _assertTargetWorld before
    // the OneOf policy hook runs, so the message is the cross-world one.
    const otherWorld = new World();
    const foreignTarget = otherWorld.entity();
    expect(() => w.entity().add(ResidesIn, foreignTarget)).toThrow(
      "Relationship target must belong to the same World"
    );
    // World partially mutated; discard both worlds.
  });
});
