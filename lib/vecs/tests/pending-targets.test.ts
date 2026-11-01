import { describe, expect, it, vi } from "vitest";
import { type Entity, Exclusive, Relationship, World } from "../src/index.js";

class Rejected extends Relationship {}
class TowedBy extends Relationship {}
class Probe {}

function setup() {
  const w = new World();
  w.component(Rejected);
  w.component(TowedBy).add(Exclusive);
  w.component(Probe);
  return { w, source: w.entity(), a: w.entity(), b: w.entity() };
}

/** Read both pending forms from a `Probe` set hook, which fires mid-drain in queue order. */
function probeDuringDrain(w: World, read: () => unknown): unknown[] {
  const seen: unknown[] = [];
  w.component(Probe).on("set", () => seen.push(read()));
  return seen;
}

describe("add(Rel, target) notification routing", () => {
  it("routes one update per add, so a following modified(Rel) routes a second", () => {
    const { w, source, a, b } = setup();
    const update = vi.fn();
    w.system("watch").with(Rejected).update(Rejected, update);
    source.add(Rejected, a);
    w.progress(0, 0);

    w.defer(() => source.add(Rejected, b));
    w.progress(0, 0);
    expect(update).toHaveBeenCalledTimes(1);

    update.mockClear();
    const c = w.entity();
    w.defer(() => {
      source.add(Rejected, c);
      source.modified(Rejected);
    });
    w.progress(0, 0);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("pending-aware targets / hasTarget", () => {
  it("defaults to committed edges only inside a deferred scope", () => {
    const { w, source, a } = setup();
    w.defer(() => {
      source.add(Rejected, a);
      expect(source.targets(Rejected)).toEqual([]);
      expect(source.hasTarget(Rejected, a)).toBe(false);
      expect(source.targets(Rejected, { pending: false })).toEqual([]);
      expect(source.hasTarget(Rejected, a, {})).toBe(false);
    });
    expect(source.targets(Rejected)).toEqual([a]);
  });

  it("reports a queued add", () => {
    const { w, source, a, b } = setup();
    source.add(Rejected, a);
    w.defer(() => {
      source.add(Rejected, b);
      source.add(Rejected, b);
      expect(source.targets(Rejected, { pending: true })).toEqual([a, b]);
      expect(source.hasTarget(Rejected, b, { pending: true })).toBe(true);
      expect(source.hasTarget(Rejected, a, { pending: true })).toBe(true);
    });
  });

  it("hides a queued edge removal and a queued whole-relationship removal", () => {
    const { w, source, a, b } = setup();
    source.add(Rejected, a);
    source.add(Rejected, b);
    w.defer(() => {
      source.remove(Rejected, a);
      expect(source.targets(Rejected, { pending: true })).toEqual([b]);
      expect(source.hasTarget(Rejected, a, { pending: true })).toBe(false);
      expect(source.hasTarget(Rejected, b, { pending: true })).toBe(true);

      source.remove(Rejected);
      expect(source.targets(Rejected, { pending: true })).toEqual([]);
      expect(source.hasTarget(Rejected, b, { pending: true })).toBe(false);

      source.add(Rejected, a);
      expect(source.targets(Rejected, { pending: true })).toEqual([a]);
      expect(source.hasTarget(Rejected, a, { pending: true })).toBe(true);
      expect(source.hasTarget(Rejected, b, { pending: true })).toBe(false);
    });
    expect(source.targets(Rejected)).toEqual([a]);
  });

  it("reports a queued add followed by its removal as absent", () => {
    const { w, source, a } = setup();
    w.defer(() => {
      source.add(Rejected, a);
      source.remove(Rejected, a);
      expect(source.targets(Rejected, { pending: true })).toEqual([]);
      expect(source.hasTarget(Rejected, a, { pending: true })).toBe(false);
    });
  });

  it("reports only the queued replacement of an Exclusive relationship", () => {
    const { w, source, a, b } = setup();
    source.add(TowedBy, a);
    w.defer(() => {
      source.add(TowedBy, b);
      expect(source.targets(TowedBy, { pending: true })).toEqual([b]);
      expect(source.hasTarget(TowedBy, a, { pending: true })).toBe(false);
      expect(source.hasTarget(TowedBy, b, { pending: true })).toBe(true);
      expect(source.hasTarget(TowedBy, a)).toBe(true);

      source.add(TowedBy, a);
      expect(source.targets(TowedBy, { pending: true })).toEqual([a]);
      expect(source.hasTarget(TowedBy, a, { pending: true })).toBe(true);
      expect(source.hasTarget(TowedBy, b, { pending: true })).toBe(false);
    });
    expect(source.targets(TowedBy)).toEqual([a]);
  });

  it("does not report a queued edge to a target destroyed before the edge applies", () => {
    const { w, source, a, b } = setup();
    const probe = w.entity();
    const seen = probeDuringDrain(w, () => [
      source.targets(Rejected, { pending: true }),
      source.hasTarget(Rejected, a, { pending: true }),
      source.hasTarget(Rejected, b, { pending: true }),
    ]);
    w.defer(() => {
      a.destroy();
      probe.set(Probe, {});
      source.add(Rejected, a);
      source.add(Rejected, b);
    });
    expect(seen).toEqual([[[b], false, true]]);
    expect(source.targets(Rejected)).toEqual([b]);
  });

  it("keeps an Exclusive edge when the queued replacement target is destroyed first", () => {
    const { w, source, a, b } = setup();
    source.add(TowedBy, a);
    const probe = w.entity();
    const seen = probeDuringDrain(w, () => [
      source.targets(TowedBy, { pending: true }),
      source.hasTarget(TowedBy, a, { pending: true }),
    ]);
    w.defer(() => {
      b.destroy();
      probe.set(Probe, {});
      source.add(TowedBy, b);
    });
    expect(seen).toEqual([[[a], true]]);
    expect(source.targets(TowedBy)).toEqual([a]);
  });

  it("reports nothing for an entity destroyed before its queued edges apply", () => {
    const { w, source, a, b } = setup();
    source.add(Rejected, a);
    const probe = w.entity();
    const seen = probeDuringDrain(w, () => [
      source.targets(Rejected, { pending: true }),
      source.hasTarget(Rejected, b, { pending: true }),
    ]);
    w.defer(() => {
      source.destroy();
      probe.set(Probe, {});
      source.add(Rejected, b);
    });
    expect(seen).toEqual([[[], false]]);
  });

  it("treats a command as committed once it applies mid-drain", () => {
    const { w, source, a, b } = setup();
    const seen: Entity[][] = [];
    w.component(Rejected).on("targetAdd", () => {
      seen.push([...source.targets(Rejected, { pending: true })]);
    });
    w.defer(() => {
      source.add(Rejected, a);
      source.add(Rejected, b);
      source.remove(Rejected, a);
    });
    expect(seen).toEqual([[b], [b]]);
    expect(source.targets(Rejected)).toEqual([b]);
  });

  it("sees edges queued in outer and nested scopes until the outermost scope drains", () => {
    const { w, source, a, b } = setup();
    w.beginDefer();
    source.add(Rejected, a);
    w.beginDefer();
    expect(source.targets(Rejected, { pending: true })).toEqual([a]);
    source.add(Rejected, b);
    w.endDefer();
    expect(source.targets(Rejected)).toEqual([]);
    expect(source.targets(Rejected, { pending: true })).toEqual([a, b]);
    expect(source.hasTarget(Rejected, b, { pending: true })).toBe(true);
    w.endDefer();
    expect(source.targets(Rejected)).toEqual([a, b]);
  });

  it("forgets applied commands, so later reads equal the committed read", () => {
    const { w, source, a } = setup();
    w.defer(() => source.add(Rejected, a));
    source.remove(Rejected, a);
    expect(source.targets(Rejected, { pending: true })).toEqual([]);
    expect(source.hasTarget(Rejected, a, { pending: true })).toBe(false);
    w.defer(() => {
      expect(source.targets(Rejected, { pending: true })).toEqual([]);
      expect(source.hasTarget(Rejected, a, { pending: true })).toBe(false);
    });
  });

  it("equals the committed read outside a deferred scope", () => {
    const { source, a, b } = setup();
    source.add(Rejected, a);
    source.add(TowedBy, b);
    expect(source.targets(Rejected, { pending: true })).toEqual(source.targets(Rejected));
    expect(source.targets(TowedBy, { pending: true })).toEqual([b]);
    expect(source.hasTarget(Rejected, a, { pending: true })).toBe(true);
    expect(source.hasTarget(Rejected, b, { pending: true })).toBe(false);
  });

  it("sees its own queued edges inside a system run", () => {
    const { w, a, b } = setup();
    const fighter = w.entity().add(Rejected, a);
    const reads: unknown[] = [];
    w.system("fighting")
      .with(Rejected)
      .each([], (e) => {
        e.add(Rejected, b);
        reads.push(e.targets(Rejected), e.targets(Rejected, { pending: true }));
      });
    w.progress(0, 0);
    expect(reads).toEqual([[a], [a, b]]);
    expect(fighter.targets(Rejected)).toEqual([a, b]);
  });
});
