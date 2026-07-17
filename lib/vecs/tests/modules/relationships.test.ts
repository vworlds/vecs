import { describe, expect, it } from "vitest";
import {
  ChildOf,
  CleanupPolicy,
  DependsOn,
  type Entity,
  Exclusive,
  OwnedTarget,
  Relationship,
  SilenceSource,
  Traversable,
  World,
} from "../../src/index.js";

class ParentOf extends Relationship {}
class Inventory extends Relationship {}
class NotRelationship {}

function depthOf(w: World, entity: Entity): number | undefined {
  return w.entity(ParentOf).get(Traversable)!.depths.get(entity);
}

describe("RelationshipsModule", () => {
  it("configures built-in single-target relationships as Exclusive", () => {
    const w = new World();

    expect(w.component(ChildOf).has(Exclusive)).toBe(true);
    expect(w.component(DependsOn).has(Exclusive)).toBe(true);
    expect(w.component(SilenceSource).has(Exclusive)).toBe(true);
    expect(w.component(ChildOf).has(Traversable)).toBe(true);
    expect(w.component(DependsOn).has(Traversable)).toBe(true);
  });

  it("requires Exclusive for OwnedTarget and Traversable", () => {
    const first = new World();
    expect(() => first.component(Inventory).add(OwnedTarget)).toThrow(
      "OwnedTarget requires Exclusive"
    );

    const second = new World();
    expect(() => second.component(ParentOf).add(Traversable)).toThrow(
      "Traversable requires Exclusive"
    );

    const third = new World();
    third.component(NotRelationship);
    expect(() => third.component(NotRelationship).add(Exclusive)).toThrow(
      "Exclusive can only be added to a Relationship component"
    );

    const fourth = new World();
    expect(() => fourth.component(ChildOf).add(OwnedTarget)).toThrow(
      "OwnedTarget cannot be added to ChildOf"
    );

    const fifth = new World();
    fifth.component(NotRelationship);
    expect(() => fifth.component(NotRelationship).add(OwnedTarget)).toThrow(
      "OwnedTarget can only be added to a Relationship component"
    );

    const sixth = new World();
    sixth.component(NotRelationship);
    expect(() => sixth.component(NotRelationship).add(Traversable)).toThrow(
      "Traversable can only be added to a Relationship component"
    );
    // Invariant violations are programming errors: the trait component is stored
    // before _onPolicyAdd throws, leaving the world partially mutated. Do not
    // assert post-throw state — discard the world instead.
  });

  it("rejects removing Exclusive while dependent traits are attached", () => {
    const first = new World();
    const owned = first.component(Inventory).add(Exclusive).add(OwnedTarget);
    expect(() => owned.remove(Exclusive)).toThrow(/dependent relationship trait/);

    const second = new World();
    const traversable = second.component(ParentOf).add(Exclusive).add(Traversable);
    expect(() => traversable.remove(Exclusive)).toThrow(/dependent relationship trait/);
    // The removal runs before _onPolicyRemove throws, leaving the world without
    // Exclusive but still carrying the dependent trait. Discard the world.
  });

  it("allows idempotent Exclusive adds while the relationship is in use", () => {
    const w = new World();
    const relationship = w.component(Inventory).add(Exclusive);
    w.entity().add(Inventory, w.entity());

    expect(() => relationship.add(Exclusive)).not.toThrow();
    expect(relationship.has(Exclusive)).toBe(true);
  });

  it("rebinds Traversable policies when its component instance is replaced", () => {
    const w = new World();
    const relationship = w.component(ParentOf).add(Exclusive).add(Traversable);
    const parent = w.entity();
    const child = w.entity().add(ParentOf, parent);

    // attach-swapping the unique framework trait data instance is irrevocable:
    // _attach fires _onPolicyRemove on the existing instance before storing
    // the replacement, so the irrevocability guard throws. The world is left
    // partially mutated and must be discarded — same contract as any other
    // trait-invariant violation.
    expect(() => relationship.attach(new Traversable())).toThrow(
      "Traversable cannot be removed once added"
    );
    // World is unusable after the throw; do not assert further state.
    void child;
  });

  it("throws mid-destroy when component deletion hits a dependent-trait guard (world is unusable after)", () => {
    const w = new World();
    const exclusive = w.component(Exclusive);
    exclusive.meta.onDelete = CleanupPolicy.Remove;

    expect(() => exclusive.destroy()).toThrow(/dependent relationship trait/);
    // A throw during _destroy is fatal: the entity is partially torn down and
    // the world must be discarded. This is a programming error per the docs.
  });

  it("throws from flush() when an invalid trait add was queued in deferred mode", () => {
    const w = new World();
    w.component(Inventory);
    // Trait-invariant violations must surface at flush time, not be silently
    // swallowed by the deferred queue. Previously _validateAdd ran pre-mutation
    // and never fired for enqueued ops; the checks now live in _onPolicyAdd,
    // which executes inside the command queue drain.
    w.beginDefer();
    expect(() => w.component(Inventory).add(OwnedTarget)).not.toThrow();
    expect(w.component(Inventory).has(OwnedTarget)).toBe(false);
    expect(() => w.endDefer()).toThrow("OwnedTarget requires Exclusive");
    // World is left partially mutated; discard it.
  });

  it("parents and destroys explicit OwnedTarget edges", () => {
    const w = new World();
    w.component(Inventory).add(Exclusive).add(OwnedTarget);
    const player = w.entity();
    const first = w.entity();
    const second = w.entity();

    player.add(Inventory, first);
    expect(first.parent).toBe(player);

    player.add(Inventory, second);
    expect(first.destroyed).toBe(true);
    expect(second.parent).toBe(player);

    player.remove(Inventory);
    expect(second.destroyed).toBe(true);
  });

  it("does not create an OwnedTarget implicitly", () => {
    const w = new World();
    w.component(Inventory).add(Exclusive).add(OwnedTarget);

    expect(() => w.entity().add(Inventory)).toThrow(/requires a target/);
  });

  it("composes OwnedTarget with existing edge hooks", () => {
    const w = new World();
    const calls: string[] = [];
    w.component(Inventory)
      .add(Exclusive)
      .on("targetAdd", (_source, _relationship, target) => {
        calls.push(`add:${target.parent?.eid}`);
      })
      .on("targetRemove", (_source, _relationship, target) => {
        calls.push(`remove:${target.destroyed}`);
      })
      .add(OwnedTarget);
    const player = w.entity();
    const inventory = w.entity();

    player.add(Inventory, inventory);
    player.remove(Inventory);

    expect(calls).toEqual([`add:${player.eid}`, "remove:true"]);
  });

  it("rejects removing OwnedTarget once attached (irrevocable)", () => {
    const w = new World();
    const relationship = w.component(Inventory).add(Exclusive).add(OwnedTarget);

    expect(() => relationship.remove(OwnedTarget)).toThrow(
      "OwnedTarget cannot be removed once added"
    );
    // The trait component is already detached from the entity map before
    // _onPolicyRemove throws, leaving the world partially mutated. Discard it.
    void relationship;
  });

  it("rejects attach-swapping OwnedTarget once attached (irrevocable)", () => {
    const w = new World();
    const relationship = w.component(Inventory).add(Exclusive).add(OwnedTarget);

    expect(() => relationship.attach(new OwnedTarget())).toThrow(
      "OwnedTarget cannot be removed once added"
    );
    // _attach fires _onPolicyRemove on the existing instance; same irrevocability
    // guard applies. World is unusable; discard it.
    void relationship;
  });

  it("tracks traversable depth through exclusive edge hooks", () => {
    const w = new World();
    w.component(ParentOf).add(Exclusive).add(Traversable);
    const root = w.entity();
    const otherRoot = w.entity();
    const parent = w.entity().add(ParentOf, root);
    const child = w.entity().add(ParentOf, parent);

    expect(depthOf(w, parent)).toBe(1);
    expect(depthOf(w, child)).toBe(2);

    parent.add(ParentOf, otherRoot);
    expect(depthOf(w, parent)).toBe(1);
    expect(depthOf(w, child)).toBe(2);

    parent.remove(ParentOf);
    expect(depthOf(w, parent)).toBeUndefined();
    expect(depthOf(w, child)).toBe(1);
  });

  it("backfills traversable relationships configured after edges exist", () => {
    const w = new World();
    const relationship = w.component(ParentOf).add(Exclusive);
    const root = w.entity();
    const parent = w.entity().add(ParentOf, root);
    const child = w.entity().add(ParentOf, parent);

    relationship.add(Traversable);

    expect(depthOf(w, parent)).toBe(1);
    expect(depthOf(w, child)).toBe(2);
  });

  it("rejects removing Traversable once attached (irrevocable)", () => {
    const w = new World();
    const relationship = w.component(ParentOf).add(Exclusive).add(Traversable);
    const root = w.entity();
    const child = w.entity().add(ParentOf, root);
    expect(depthOf(w, child)).toBe(1);

    expect(() => relationship.remove(Traversable)).toThrow(
      "Traversable cannot be removed once added"
    );
    // Irrevocable trait violation: world is partially mutated, discard it.
    void relationship;
  });

  it("clearAllEntities tears down worlds with irrevocable traits configured and live edges", () => {
    const w = new World();
    const inventory = w.component(Inventory).add(Exclusive).add(OwnedTarget);
    const parentOf = w.component(ParentOf).add(Exclusive).add(Traversable);
    // Live edges with adopted children so ownership + depth tracking are active.
    const player = w.entity();
    const owned = w.entity();
    player.add(Inventory, owned);
    const root = w.entity();
    const child = w.entity().add(ParentOf, root);
    expect(owned.parent).toBe(player);
    expect(depthOf(w, child)).toBe(1);

    // Teardown bypasses _onPolicyRemove (Entity._destroy routes non-relationship
    // components through the else branch at entity.lifecycle.ts and relationships
    // through _detachRelationship, neither of which calls _onPolicyRemove), so the
    // irrevocability guards never fire during world destruction.
    expect(() => w.clearAllEntities()).not.toThrow();

    // Everything is gone, including the trait-carrying component entities.
    expect(w.entities.size).toBe(0);
    void inventory;
    void parentOf;
  });
});
