import { describe, it, expect, vi } from "vitest";
import {
  ChildOf,
  ClonePublic,
  CustomSnapshot,
  DontSnapshot,
  Exclusive,
  MoveSubtreeError,
  Implements,
  Relationship,
  type Entity,
  World,
} from "../src/index.js";
import type { ComponentType } from "../src/component.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
}
class Hull {
  hp = 100;
}
class Tag {
  label = "";
}
class Session {
  id = "";
}
class Carries extends Relationship {
  weight = 0;
}
class TetheredTo extends Relationship {
  ropeLength = 5;
}
class PartOf extends Relationship {}
class Manifest extends Relationship {}

const COMPONENTS = [Position, Velocity, Hull, Tag, Session, Carries, TetheredTo, PartOf, Manifest];

function makeWorld(): World {
  const world = new World();
  COMPONENTS.forEach((component) => world.component(component));
  return world;
}

/** Run `operation` and return whatever it threw. */
function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw");
}

/** Number of entities in `world` carrying `component`. */
function carried(world: World, component: ComponentType): number {
  return world.component(component).meta.usageCount;
}

/** Targets of `rel` on `entity`, as a comparable array. */
function targets(entity: Entity, rel: typeof ChildOf): number[] {
  return entity.targets(rel).map((target) => target.eid);
}

describe("snapshotSubtree", () => {
  it("captures a root and its transitive ChildOf descendants", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);
    const mid = w.entity().add(Position).add(ChildOf, root);
    const leaf = w.entity().add(Hull).add(ChildOf, mid);

    const snapshot = w.snapshotSubtree(root);

    expect(snapshot.roots).toEqual([root.eid]);
    expect(snapshot.entities.map((record) => record.source)).toEqual([root, mid, leaf]);
    expect(snapshot.traversal).toBe(ChildOf);
    expect(snapshot.entities[2].components.map((c) => c.Class)).toEqual([Hull]);
  });

  it("captures several independent roots as one atomic forest", () => {
    const w = makeWorld();
    const a = w.entity().add(Tag);
    const b = w.entity().add(Tag);

    const snapshot = w.snapshotSubtree([a, b]);

    expect(snapshot.roots).toEqual([a.eid, b.eid]);
    expect(snapshot.entities.map((record) => record.source)).toEqual([a, b]);
  });

  it("captures an entity with no components and no edges", () => {
    const w = makeWorld();

    const snapshot = w.snapshotSubtree(w.entity());

    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0].components).toEqual([]);
    expect(snapshot.entities[0].relationships).toEqual([]);
  });

  it("marks the caller-supplied roots as roots", () => {
    const w = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root);

    const snapshot = w.snapshotSubtree(root);

    expect(snapshot.entities.map((record) => record.root)).toEqual([true, false]);
    expect(child.has(ChildOf)).toBe(true);
  });

  it("follows a custom traversal relationship", () => {
    const w = makeWorld();
    const root = w.entity();
    const child = w.entity().add(PartOf, root);
    const grandchild = w.entity().add(PartOf, child);
    const ignored = w.entity().add(ChildOf, root);

    const snapshot = w.snapshotSubtree(root, { traversal: PartOf });

    expect(snapshot.entities.map((r) => r.source)).toEqual([root, child, grandchild]);
    expect(snapshot.entities.map((r) => r.source)).not.toContain(ignored);
  });

  it("captures only allowlisted components and relationships", () => {
    const w = makeWorld();
    const root = w.entity().add(Position).add(Velocity).add(Tag);
    const child = w.entity().add(Hull).add(ChildOf, root).add(Carries, root);

    const snapshot = w.snapshotSubtree(root, {
      components: [Position, Hull],
      relationships: [ChildOf, Carries],
    });

    expect(snapshot.entities[0].components.map((c) => c.Class)).toEqual([Position]);
    expect(snapshot.entities[1].components.map((c) => c.Class)).toEqual([Hull]);
    expect(snapshot.entities[1].relationships.map((r) => r.Class)).toEqual([ChildOf, Carries]);
  });

  it("excludes a type absent from a non-empty component allowlist", () => {
    const w = makeWorld();
    const root = w.entity().add(Position).add(Velocity);

    const snapshot = w.snapshotSubtree(root, { components: [Position] });

    expect(snapshot.entities[0].components.map((c) => c.Class)).toEqual([Position]);
  });

  it("excludes a relationship absent from a non-empty allowlist", () => {
    const w = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(Carries, root);

    const snapshot = w.snapshotSubtree(root, { relationships: [ChildOf] });

    expect(snapshot.entities[1].relationships.map((r) => r.Class)).toEqual([ChildOf]);
  });

  it("rejects an unregistered traversal relationship", () => {
    const w = makeWorld();
    class Unregistered extends Relationship {}

    expect(() => w.snapshotSubtree(w.entity(), { traversal: Unregistered })).toThrow(
      /traversal class 'Unregistered' is not registered/
    );
  });

  it("rejects an unregistered component in the allowlist", () => {
    const w = makeWorld();
    class Unregistered {}

    expect(() => w.snapshotSubtree(w.entity(), { components: [Unregistered] })).toThrow(
      /components class 'Unregistered' is not registered/
    );
  });

  it("throws when a root is reachable twice", () => {
    const w = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root);

    expect(() => w.snapshotSubtree([root, child])).toThrow(/is a member of the forest twice/);
  });

  it("throws when the same root is listed twice", () => {
    const w = makeWorld();
    const root = w.entity();

    expect(() => w.snapshotSubtree([root, root])).toThrow(/is a member of the forest twice/);
  });

  it("throws on a traversal cycle", () => {
    const w = makeWorld();
    class Ring extends Relationship {}
    w.component(Ring);
    // `Ring` has no exclusivity constraint, so a cycle can be built directly.
    const a = w.entity();
    const b = w.entity();
    a.add(Ring, b);
    b.add(Ring, a);

    expect(() => w.snapshotSubtree(a, { traversal: Ring })).toThrow(/Ring cycle reaches/);
  });

  it("rejects an empty root list", () => {
    const w = makeWorld();

    expect(() => w.snapshotSubtree([])).toThrow(/requires at least one root/);
  });

  it("rejects a destroyed root", () => {
    const w = makeWorld();
    const root = w.entity();
    root.destroy();

    expect(() => w.snapshotSubtree(root)).toThrow(/destroyed entity/);
  });

  it("rejects a component-definition entity as a root", () => {
    const w = makeWorld();

    expect(() => w.snapshotSubtree(w.component(Position))).toThrow(
      /snapshot ordinary entities only/
    );
  });

  it("rejects an entity from another world", () => {
    const w = makeWorld();
    const other = makeWorld();

    expect(() => w.snapshotSubtree(other.entity())).toThrow(/must belong to the source world/);
  });

  it("throws while the world is deferred", () => {
    const w = makeWorld();
    w.beginDefer();

    expect(() => w.snapshotSubtree(w.entity())).toThrow(
      /snapshotSubtree cannot run while the world is deferred/
    );
  });

  it("does not mutate the source", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root).add(Carries, root);
    child.set(Carries, { weight: 3 });

    w.snapshotSubtree(root);

    expect(root.has(Position)).toBe(true);
    expect(targets(child, ChildOf)).toEqual([root.eid]);
    expect(targets(child, Carries)).toEqual([root.eid]);
    expect(child.get(Carries)!.weight).toBe(3);
    expect(child.targets(Carries)[0]).toBe(root);
  });
});

describe("snapshot capture — ClonePublic", () => {
  it("copies own enumerable fields", () => {
    const w = makeWorld();
    const root = w.entity().add(Position).add(Tag);
    root.set(Position, { x: 3, y: 4 });
    root.set(Tag, { label: "hull" });

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components).toHaveLength(2);
    const position = record.components.find((c) => c.Class === Position)!;
    const tag = record.components.find((c) => c.Class === Tag)!;
    expect(position.data).toEqual({ x: 3, y: 4 });
    expect(tag.data).toEqual({ label: "hull" });
  });

  it("does not share the captured object with the source instance", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components[0].data).not.toBe(root.get(Position));
  });

  it("clones an explicit ClonePublic policy", () => {
    const w = makeWorld();
    w.component(Session).snapshotPolicy(ClonePublic);
    const root = w.entity().add(Session);
    root.set(Session, { id: "abc" });

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components[0].data).toEqual({ id: "abc" });
  });

  it("captures interface fields of an Implements type", () => {
    const w = makeWorld();
    class Health {
      hp = 10;
    }
    class Armor {
      plating = 2;
    }
    class ArmoredPosition extends Position implements Health, Armor {
      hp = 10;
      plating = 2;
    }
    w.component(Health);
    w.component(Armor);
    w.component(ArmoredPosition).set(Implements, { interfaces: [Health, Armor] });
    const root = w.entity().add(ArmoredPosition);
    root.set(ArmoredPosition, { hp: 4, plating: 1 });

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components).toHaveLength(1);
    expect(record.components[0].Class).toBe(ArmoredPosition);
    expect(record.components[0].data).toMatchObject({ hp: 4, plating: 1 });
  });
});

describe("snapshot capture — DontSnapshot", () => {
  it("skips a DontSnapshot type by default", () => {
    const w = makeWorld();
    w.component(Session).snapshotPolicy(DontSnapshot);
    const root = w.entity().add(Position).add(Session);

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components.map((c) => c.Class)).toEqual([Position]);
  });

  it("throws when a DontSnapshot component is explicitly selected", () => {
    const w = makeWorld();
    w.component(Session).snapshotPolicy(DontSnapshot);
    const root = w.entity().add(Position).add(Session);

    expect(() => w.snapshotSubtree(root, { components: [Position, Session] })).toThrow(
      /Session is declared DontSnapshot/
    );
  });

  it("throws when a DontSnapshot relationship is explicitly selected", () => {
    const w = makeWorld();
    w.component(TetheredTo).snapshotPolicy(DontSnapshot);
    const root = w.entity();
    w.entity().add(ChildOf, root).add(TetheredTo, root);

    expect(() => w.snapshotSubtree(root, { relationships: [TetheredTo] })).toThrow(
      /TetheredTo is declared DontSnapshot/
    );
  });

  it("skips a DontSnapshot relationship by default", () => {
    const w = makeWorld();
    w.component(TetheredTo).snapshotPolicy(DontSnapshot);
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(TetheredTo, root);

    const snapshot = w.snapshotSubtree(root);

    expect(snapshot.entities[1].relationships.map((r) => r.Class)).toEqual([ChildOf]);
    expect(targets(child, TetheredTo)).toEqual([root.eid]);
  });

  it("allows a policy change while the type has carriers", () => {
    const w = makeWorld();
    w.entity().add(Session);

    expect(() => w.component(Session).snapshotPolicy(DontSnapshot)).not.toThrow();
  });

  it("restores with the materializer bound at capture time, not the current policy", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Session);
    root.getMut(Session, (session) => {
      session.id = "bound";
    });
    const snapshot = w.snapshotSubtree(root);

    // Declared after the capture: the snapshot must ignore it.
    other.component(Session).snapshotPolicy(CustomSnapshot, {
      capture: () => ({ id: "late" }),
      materialize: () => new Session(),
    });

    const result = w.restoreSubtree(other, snapshot);

    expect(result.roots[0].get(Session)!.id).toBe("bound");
  });

  it("restores a custom policy declared after capture", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Session);
    root.getMut(Session, (session) => {
      session.id = "captured";
    });
    w.component(Session).snapshotPolicy(CustomSnapshot, {
      capture: (session) => ({ id: String((session as Session).id).toUpperCase() }),
      materialize: (data) => Object.assign(new Session(), data),
    });
    const snapshot = w.snapshotSubtree(root);

    // Revoking the policy later must not strand the snapshot.
    w.component(Session).snapshotPolicy(ClonePublic);

    const result = w.restoreSubtree(other, snapshot);

    expect(result.roots[0].get(Session)!.id).toBe("CAPTURED");
  });

  it("rejects a custom policy without callbacks", () => {
    const w = makeWorld();

    expect(() => w.component(Session).snapshotPolicy(CustomSnapshot)).toThrow(
      /snapshotPolicy\(CustomSnapshot\) requires both capture and materialize callbacks/
    );
  });

  it("marks live queries and systems DontSnapshot", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);
    root.attach(w.query("snapshot-test"));
    root.attach(w.system("snapshot-system"));

    const [record] = w.snapshotSubtree(root).entities;

    expect(record.components.map((c) => c.Class)).toEqual([Position]);
  });
});

describe("snapshot capture — CustomSnapshot", () => {
  it("routes component capture through the owner callback", () => {
    const w = makeWorld();
    const capture = vi.fn(() => ({ amount: 7 }));
    w.component(Session).snapshotPolicy(CustomSnapshot, {
      capture: () => capture(),
      materialize: () => new Session(),
    });
    const root = w.entity().add(Session);

    const [record] = w.snapshotSubtree(root).entities;

    expect(capture).toHaveBeenCalledTimes(1);
    expect(record.components[0].data).toEqual({ amount: 7 });
  });

  it("passes the live instance to the capture callback", () => {
    const w = makeWorld();
    let seen: Session | undefined;
    w.component(Session).snapshotPolicy(CustomSnapshot, {
      capture: (instance) => {
        seen = instance as Session;
        return { id: seen.id };
      },
      materialize: () => new Session(),
    });
    const root = w.entity().add(Session);
    root.set(Session, { id: "live" });

    w.snapshotSubtree(root);

    expect(seen).toBeInstanceOf(Session);
    expect(seen!.id).toBe("live");
  });

  it("captures relationship data through a custom policy", () => {
    const w = makeWorld();
    w.component(TetheredTo).snapshotPolicy(CustomSnapshot, {
      capture: (instance) => ({ broken: (instance as TetheredTo).ropeLength < 1 }),
      materialize: () => new TetheredTo(),
    });
    const root = w.entity();
    w.entity().add(ChildOf, root).add(TetheredTo, root).set(TetheredTo, {
      ropeLength: 0,
    });

    const snapshot = w.snapshotSubtree(root);
    const tether = snapshot.entities[1].relationships.find((r) => r.Class === TetheredTo)!;

    expect(tether.data).toEqual({ broken: true });
    expect(tether.targets).toEqual([root.eid]);
  });
});

describe("snapshot capture — external targets", () => {
  it("records an external target instead of following it", () => {
    const w = makeWorld();
    const outside = w.entity().add(Hull);
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(Carries, outside);

    const snapshot = w.snapshotSubtree(root);
    const carries = snapshot.entities[1].relationships.find((r) => r.Class === Carries)!;

    expect(carries.targets).toEqual([]);
    expect(carries.externalTargets).toBe(1);
    expect(snapshot.entities.map((r) => r.source)).not.toContain(outside);
    expect(targets(child, Carries)).toEqual([outside.eid]);
  });

  it("throws under the error policy", () => {
    const w = makeWorld();
    const root = w.entity();
    w.entity().add(ChildOf, root).add(Carries, w.entity());

    expect(() => w.snapshotSubtree(root, { externalTargets: "error" })).toThrow(
      /Carries on entity .* is outside the captured subtree/
    );
  });

  it("does not throw when no external target exists", () => {
    const w = makeWorld();
    const root = w.entity();
    w.entity().add(ChildOf, root);

    expect(() => w.snapshotSubtree(root, { externalTargets: "error" })).not.toThrow();
  });

  it("rejects an unknown external-target policy", () => {
    const w = makeWorld();

    expect(() => w.snapshotSubtree(w.entity(), { externalTargets: "throw" as "omit" })).toThrow(
      /externalTargets must be "omit" or "error"/
    );
  });
});

describe("snapshot capture — relationship data", () => {
  it("keeps edge targets out of the captured data", () => {
    const w = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(Carries, root);
    child.set(Carries, { weight: 9 });

    const snapshot = w.snapshotSubtree(root);
    const carries = snapshot.entities[1].relationships.find((r) => r.Class === Carries)!;

    expect(carries.data).toEqual({ weight: 9 });
    expect(carries.data).not.toHaveProperty("target");
    expect(carries.data).not.toHaveProperty("targets");
    expect(carries.data).not.toHaveProperty("_targets");
  });

  it("captures every internal target of a multi-target relationship", () => {
    const w = makeWorld();
    const a = w.entity();
    const b = w.entity();
    const hub = w.entity();
    hub.add(Carries, a).add(Carries, b);

    const snapshot = w.snapshotSubtree([a, b, hub]);
    const record = snapshot.entities.find((r) => r.source === hub)!;
    const carries = record.relationships.find((r) => r.Class === Carries)!;

    expect([...carries.targets].sort()).toEqual([a.eid, b.eid].sort());
    expect(carries.externalTargets).toBe(0);
  });

  it("separates internal from external targets", () => {
    const w = makeWorld();
    const inside = w.entity();
    const outside = w.entity();
    const hub = w.entity();
    hub.add(Carries, inside).add(Carries, outside);

    const snapshot = w.snapshotSubtree([inside, hub]);
    const record = snapshot.entities.find((r) => r.source === hub)!;
    const carries = record.relationships.find((r) => r.Class === Carries)!;

    expect(carries.targets).toEqual([inside.eid]);
    expect(carries.externalTargets).toBe(1);
  });

  it("captures an empty relationship payload as an empty object", () => {
    const w = makeWorld();
    const root = w.entity();
    w.entity().add(ChildOf, root);

    const snapshot = w.snapshotSubtree(root);
    const childOf = snapshot.entities[1].relationships.find((r) => r.Class === ChildOf)!;

    expect(childOf.data).toEqual({});
  });

  it("keeps a relationship's own data independent of the remapped edges", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(Carries, root);
    child.set(Carries, { weight: 4 });

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restoredChild = result.entities.get(child.eid)!;

    expect(restoredChild.get(Carries)!.weight).toBe(4);
    expect(targets(restoredChild, Carries)).toEqual([result.roots[0].eid]);
  });
});

describe("snapshot capture — deep copy", () => {
  it("copies nested arrays, objects, and vectors instead of aliasing them", () => {
    const w = makeWorld();
    const other = makeWorld();
    class Rig extends Relationship {
      data: unknown = undefined;
    }
    w.component(Rig);
    other.component(Rig);
    const root = w.entity().add(Position);

    const live = {
      name: "cargo",
      vertices: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      hull: { hp: 100, tag: "outer" },
    };
    root.add(Rig, root).set(Rig, { data: live });

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restored = result.roots[0].get(Rig)!.data as typeof live;

    expect(restored).toEqual(live);
    expect(restored).not.toBe(live);
    expect(restored.vertices).not.toBe(live.vertices);
    expect(restored.vertices[0]).not.toBe(live.vertices[0]);
    expect(restored.hull).not.toBe(live.hull);

    live.vertices.push({ x: 5, y: 6 });
    live.hull.hp = 1;
    expect(restored.vertices).toHaveLength(2);
    expect(restored.hull.hp).toBe(100);
  });

  it("copies Map, Set, Date, and typed arrays", () => {
    const w = makeWorld();
    const other = makeWorld();
    class Collections {
      when = new Date(1_700_000_000_000);
      tags = new Set(["a", "b"]);
      weights = new Map<string, number>([["ore", 3]]);
      bytes = new Uint8Array([1, 2, 3]);
    }
    w.component(Collections);
    other.component(Collections);
    const live = new Collections();
    const root = w.entity().set(Collections, live);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restored = result.roots[0].get(Collections)!;

    expect(restored.when).toEqual(live.when);
    expect(restored.when).not.toBe(live.when);
    expect(restored.tags).toEqual(live.tags);
    expect(restored.tags).not.toBe(live.tags);
    expect(restored.weights).toEqual(live.weights);
    expect(restored.weights).not.toBe(live.weights);
    expect(restored.bytes).toEqual(live.bytes);
    expect(restored.bytes).not.toBe(live.bytes);
  });

  it("preserves a cycle as a cycle", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const live: Record<string, unknown> = { name: "loop" };
    live.self = live;
    root.getMut(Position, (position) => {
      Object.assign(position, live);
    });

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const detached = (result.roots[0].get(Position)! as unknown as Record<string, unknown>)
      .self as Record<string, unknown>;

    expect(detached.self).toBe(detached);
    expect(detached).not.toBe(live);
    expect(detached.name).toBe("loop");
  });

  it("fails loudly at capture on a nested non-plain instance", () => {
    const w = makeWorld();
    const other = makeWorld();
    class Handle {
      constructor(readonly id = "live") {}
    }
    class Physics extends Relationship {
      handle = new Handle();
    }
    w.component(Physics);
    other.component(Physics);
    const root = w.entity().add(Position);
    w.entity().childOf(root).add(Physics, root);

    expect(() => w.snapshotSubtree(root)).toThrow(
      /Physics\.handle holds a Handle, which the default ClonePublic policy cannot copy; declare a CustomSnapshot policy on Physics/
    );
  });

  it("lets an owner-declared policy capture what the default refuses", () => {
    const w = makeWorld();
    const other = makeWorld();
    class Handle {
      constructor(readonly id = "live") {}
    }
    class Physics extends Relationship {
      handle = new Handle();
    }
    w.component(Physics);
    other.component(Physics);
    w.component(Physics).snapshotPolicy(CustomSnapshot, {
      capture: (physics) => ({ id: (physics as Physics).handle.id }),
      materialize: (data) =>
        Object.assign(new Physics(), { handle: new Handle((data as { id: string }).id) }),
    });
    const root = w.entity().add(Position);
    w.entity().childOf(root).add(Physics, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const child = [...result.entities.values()][1]!;

    expect(child.targets(Physics)).toHaveLength(1);
    expect(child.get(Physics)!.handle.id).toBe("live");
  });
});

describe("snapshotSubtree — edges outside the forest", () => {
  it("never carries an inbound edge, by capture or by restore", () => {
    const w = makeWorld();
    const other = makeWorld();
    const outside = w.entity().add(Position);
    const root = w.entity().add(Position);
    w.entity().add(Carries, root).set(Carries, { weight: 3 });
    outside.add(TetheredTo, root);

    const snapshot = w.snapshotSubtree(root);
    const result = w.restoreSubtree(other, snapshot);

    expect(result.entities.size).toBe(1);
    expect(targets(outside, TetheredTo)).toEqual([root.eid]);
    expect(result.roots[0].targets(TetheredTo)).toHaveLength(0);
  });

  it("drops an inbound edge when the subtree is moved away", () => {
    const w = makeWorld();
    const other = makeWorld();
    const outside = w.entity().add(Position);
    const root = w.entity().add(Position);
    outside.add(TetheredTo, root);

    const moved = w.moveSubtree(root, other);

    expect(outside.targets(TetheredTo)).toHaveLength(0);
    expect(outside.destroyed).toBe(false);
    expect(moved.roots[0].targets(TetheredTo)).toHaveLength(0);
  });
});

describe("restoreSubtree", () => {
  it("restores into a second world with fresh entities", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(Hull).add(ChildOf, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restoredRoot = result.roots[0];
    const restoredChild = result.entities.get(child.eid)!;

    expect(restoredRoot).not.toBe(root);
    expect(restoredChild).not.toBe(child);
    expect(restoredRoot.world).toBe(other);
    expect(restoredChild.targets(ChildOf)[0]).toBe(restoredRoot);
  });

  it("returns both snapshot-key and source-entity maps", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(result.entities.get(root.eid)).toBe(result.roots[0]);
    expect(result.entities.get(child.eid)).toBe(result.sourceToDestination.get(child));
    expect(result.sourceToDestination.get(root)).toBe(result.roots[0]);
    expect(result.sourceToDestination.size).toBe(2);
  });

  it("restores several roots as one forest", () => {
    const w = makeWorld();
    const other = makeWorld();
    const a = w.entity().add(Position);
    const b = w.entity().add(Velocity);

    const result = w.restoreSubtree(other, w.snapshotSubtree([a, b]));

    expect(result.roots).toHaveLength(2);
    expect(result.roots.every((entity) => entity.world === other)).toBe(true);
  });

  it("never shares a component instance with the source", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    root.set(Position, { x: 5, y: 6 });

    const restored = w.restoreSubtree(other, w.snapshotSubtree(root)).roots[0];
    const position = restored.get(Position)!;

    expect(position).not.toBe(root.get(Position));
    expect(position).toBeInstanceOf(Position);
    expect(position.x).toBe(5);
    expect(position.y).toBe(6);
  });

  it("keeps each world's copy independent", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);

    const restored = w.restoreSubtree(other, w.snapshotSubtree(root)).roots[0];
    restored.set(Position, { x: 9, y: 9 });

    expect(root.get(Position)!.x).toBe(0);
  });

  it("restores a nested hierarchy", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const mid = w.entity().add(Velocity).add(ChildOf, root);
    const leaf = w.entity().add(Hull).add(ChildOf, mid);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restoredRoot = result.roots[0];
    const restoredMid = result.entities.get(mid.eid)!;
    const restoredLeaf = result.entities.get(leaf.eid)!;

    expect(targets(restoredMid, ChildOf)).toEqual([restoredRoot.eid]);
    expect(targets(restoredLeaf, ChildOf)).toEqual([restoredMid.eid]);
    expect(restoredLeaf.get(Hull)!.hp).toBe(100);
    expect(restoredMid.get(Velocity)!.vx).toBe(0);
  });

  it("remaps every target of a multi-target relationship", () => {
    const w = makeWorld();
    const other = makeWorld();
    const a = w.entity().add(Position);
    const b = w.entity().add(Position);
    const hub = w.entity();
    hub.add(Carries, a).add(Carries, b);

    const result = w.restoreSubtree(other, w.snapshotSubtree([a, b, hub]));
    const restoredHub = result.entities.get(hub.eid)!;

    expect(
      restoredHub
        .targets(Carries)
        .map((t) => t.eid)
        .sort()
    ).toEqual([result.entities.get(a.eid)!.eid, result.entities.get(b.eid)!.eid].sort());
  });

  it("remaps the single target of an Exclusive relationship", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.setExclusiveComponents(Position, Velocity));
    const root = w.entity().add(Position);
    const child = w.entity().add(Velocity).add(ChildOf, root).add(PartOf, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));
    const restoredChild = result.entities.get(child.eid)!;

    expect(targets(restoredChild, PartOf)).toEqual([result.roots[0].eid]);
    expect(restoredChild.has(Velocity)).toBe(true);
    expect(restoredChild.has(Position)).toBe(false);
  });

  it("keeps a relationship instance per target", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.setExclusiveComponents(Position, Velocity));
    const a = w.entity().add(Position);
    const b = w.entity().add(Velocity);
    const hub = w.entity();
    hub.add(Carries, a).add(Carries, b);

    const result = w.restoreSubtree(other, w.snapshotSubtree([a, b, hub]));
    const restoredHub = result.entities.get(hub.eid)!;

    expect(restoredHub.targets(Carries)).toHaveLength(2);
    expect(restoredHub.get(Carries)).toBeInstanceOf(Carries);
    expect(restoredHub.get(Carries)!.weight).toBe(0);
  });

  it("creates a fresh relationship instance for an empty payload", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(result.entities.get(child.eid)!.get(ChildOf)).toBeInstanceOf(ChildOf);
  });

  it("drops external targets left behind at capture time", () => {
    const w = makeWorld();
    const other = makeWorld();
    const outside = w.entity();
    const root = w.entity();
    w.entity().add(ChildOf, root).add(Carries, outside);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(result.entities.get(root.eid)!.targets(ChildOf)).toHaveLength(0);
    expect(carried(other, Position)).toBe(0);
  });

  it("leaves the source untouched", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root);

    w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(child.destroyed).toBe(false);
    expect(carried(w, Position)).toBe(1);
    expect(targets(child, ChildOf)).toEqual([root.eid]);
  });

  it("runs add hooks once per component", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const onAdd = vi.fn();
    other.component(Position).on("add", onAdd);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toBe(result.roots[0]);
    expect(onAdd).toHaveBeenCalledWith(result.roots[0], expect.any(Position));
  });

  it("materializes through a custom owner policy", () => {
    const w = makeWorld();
    const other = makeWorld();
    const materialize = vi.fn(() => {
      const session = new Session();
      session.id = "materialized";
      return session;
    });
    [w, other].forEach((world) =>
      world.component(Session).snapshotPolicy(CustomSnapshot, {
        capture: (instance) => ({ id: (instance as Session).id }),
        materialize,
      })
    );
    const root = w.entity().add(Session);
    root.set(Session, { id: "abc" });

    const restored = w.restoreSubtree(other, w.snapshotSubtree(root)).roots[0];

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith({ id: "abc" });
    expect(restored.get(Session)!.id).toBe("materialized");
  });

  it("rebuilds traversal edges before other edges", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(PartOf, root);
    const order: string[] = [];
    other.component(PartOf).on("targetPolicyAdd", (entity, _rel, target) => {
      expect(targets(entity, ChildOf)).toHaveLength(1);
      order.push("part");
    });

    w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(order).toEqual(["part"]);
    expect(child.targets(PartOf)).toHaveLength(1);
  });

  it("restores the surviving target of a replaced Exclusive edge", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.component(Carries).add(Exclusive));
    const a = w.entity();
    const b = w.entity();
    const hub = w.entity();
    hub.add(Carries, a).add(Carries, b);
    expect(targets(hub, Carries)).toEqual([b.eid]);

    const result = w.restoreSubtree(other, w.snapshotSubtree([a, b, hub]));

    expect(targets(result.sourceToDestination.get(hub)!, Carries)).toEqual([
      result.sourceToDestination.get(b)!.eid,
    ]);
  });

  it("throws when a captured class is unregistered in the destination", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);
    const other = new World();

    expect(() => w.restoreSubtree(other, w.snapshotSubtree(root))).toThrow(
      /'Position' captured for entity .* is not registered in the destination world/
    );
  });

  it("throws when a captured relationship class is unregistered", () => {
    class Unregistered extends Relationship {}
    const w = makeWorld();
    w.component(Unregistered);
    const other = new World();
    const root = w.entity();
    w.entity().add(ChildOf, root).add(Unregistered, root);

    expect(() => w.restoreSubtree(other, w.snapshotSubtree(root))).toThrow(
      /'Unregistered' captured for entity .* is not registered in the destination world/
    );
  });

  it("throws when a captured class is DontSnapshot in the destination", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    other.component(Position).snapshotPolicy(DontSnapshot);

    expect(() => w.restoreSubtree(other, w.snapshotSubtree(root))).toThrow(
      /'Position' captured for entity .* is declared DontSnapshot in the destination world/
    );
    expect(carried(other, Position)).toBe(0);
  });

  it("rolls back every created entity when materialization fails", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    w.entity().add(ChildOf, root).add(Session);
    w.component(Session).snapshotPolicy(CustomSnapshot, {
      capture: () => ({}),
      materialize: () => {
        throw new Error("boom");
      },
    });

    expect(() => w.restoreSubtree(other, w.snapshotSubtree(root))).toThrow("boom");
    expect(carried(other, Position)).toBe(0);
  });

  it("rolls back when a relationship edge is refused", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    w.entity().add(ChildOf, root);
    other.component(ChildOf).on("targetPolicyAdd", () => {
      throw new Error("nope");
    });

    expect(() => w.restoreSubtree(other, w.snapshotSubtree(root))).toThrow("nope");
    expect(carried(other, Position)).toBe(0);
  });

  it("throws when an edge target is missing from the snapshot", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root);
    const snapshot = w.snapshotSubtree(root);
    const malformed = {
      ...snapshot,
      entities: snapshot.entities.map((record) =>
        record.source === child
          ? {
              ...record,
              relationships: record.relationships.map((relationship, index) =>
                index === 0 ? { ...relationship, targets: [999_999] } : relationship
              ),
            }
          : record
      ),
    };

    expect(() => w.restoreSubtree(other, malformed)).toThrow(/is not part of the snapshot/);
    expect(carried(other, Position)).toBe(0);
  });

  it("throws while the source world is deferred", () => {
    const w = makeWorld();
    const other = makeWorld();
    const snapshot = w.snapshotSubtree(w.entity());
    w.beginDefer();

    expect(() => w.restoreSubtree(other, snapshot)).toThrow(
      /restoreSubtree cannot run while the world is deferred/
    );
  });

  it("throws while the destination world is deferred", () => {
    const w = makeWorld();
    const other = makeWorld();
    const snapshot = w.snapshotSubtree(w.entity());
    other.beginDefer();

    expect(() => w.restoreSubtree(other, snapshot)).toThrow(
      /restoreSubtree cannot run while the world is deferred/
    );
  });
});

describe("moveSubtree", () => {
  it("transfers a forest and destroys the source", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root).add(Hull);

    const result = w.moveSubtree(root, other);

    expect(root.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].world).toBe(other);
    expect(result.roots[0].has(Position)).toBe(true);
    expect(result.entities.get(child.eid)!.has(Hull)).toBe(true);
  });

  it("restores several roots as one forest", () => {
    const w = makeWorld();
    const other = makeWorld();
    const a = w.entity().add(Position);
    const b = w.entity().add(Velocity);

    const result = w.moveSubtree([a, b], other);

    expect(result.roots).toHaveLength(2);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
  });

  it("preserves values and remaps edges", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    root.set(Position, { x: 7, y: 8 });
    const child = w.entity().add(ChildOf, root).add(Carries, root);
    child.set(Carries, { weight: 3 });

    const result = w.moveSubtree(root, other);
    const restoredChild = result.entities.get(child.eid)!;

    expect(result.roots[0].get(Position)!.x).toBe(7);
    expect(result.roots[0].get(Position)!.y).toBe(8);
    expect(targets(restoredChild, ChildOf)).toEqual([result.roots[0].eid]);
    expect(targets(restoredChild, Carries)).toEqual([result.roots[0].eid]);
    expect(restoredChild.get(Carries)!.weight).toBe(3);
  });

  it("gives the destination fresh instances", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const before = root.get(Position);

    const restored = w.moveSubtree(root, other).roots[0];

    expect(restored.get(Position)).not.toBe(before);
    expect(restored.get(Position)).toBeInstanceOf(Position);
  });

  it("fires source component remove hooks", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root).add(Hull);
    const onRemove = vi.fn();
    w.component(Position).on("remove", onRemove);
    w.component(Hull).on("remove", onRemove);

    w.moveSubtree(root, other);

    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove.mock.calls.map((call) => call[0])).toEqual([root, child]);
  });

  it("cleans up source relationship registrations", () => {
    const w = makeWorld();
    const other = makeWorld();
    const anchor = w.entity();
    const root = w.entity();
    w.entity().add(ChildOf, root).add(Carries, anchor);

    w.moveSubtree(root, other);

    expect([...anchor.children(Carries)]).toHaveLength(0);
    expect([...anchor.children(ChildOf)]).toHaveLength(0);
  });

  it("runs add hooks in the destination", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const onAdd = vi.fn();
    other.component(Position).on("add", onAdd);

    w.moveSubtree(root, other);

    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("leaves the source intact when preflight fails", () => {
    const w = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root);
    const destination = new World();

    expect(() => w.moveSubtree(root, destination)).toThrow(
      /is not registered in the destination world/
    );
    expect(root.destroyed).toBe(false);
    expect(child.destroyed).toBe(false);
    expect(carried(w, Position)).toBe(1);
    expect(targets(child, ChildOf)).toEqual([root.eid]);
  });

  it("restores the source forest when the destination restore fails", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    root.set(Position, { x: 2, y: 3 });
    const child = w.entity().add(ChildOf, root).add(Hull);
    other.component(Hull).on("add", () => {
      throw new Error("destination exploded");
    });

    const error = captureError(() => w.moveSubtree(root, other));

    expect(error).toBeInstanceOf(MoveSubtreeError);
    expect((error as Error).message).toMatch(/source forest was restored with new entity ids/);
    expect(((error as MoveSubtreeError).cause as Error).message).toBe("destination exploded");
    expect((error as MoveSubtreeError).rollbackFailed).toBe(false);

    expect(carried(other, Position)).toBe(0);
    expect(carried(other, Hull)).toBe(0);
    expect(carried(w, Position)).toBe(1);
    expect(carried(w, Hull)).toBe(1);
    const [rebuiltRoot] = [...w.query("rollback-root").with(Position).build()];
    const [rebuiltChild] = [...w.query("rollback-child").with(Hull).build()];
    expect(rebuiltRoot.get(Position)!.x).toBe(2);
    expect(targets(rebuiltChild, ChildOf)).toEqual([rebuiltRoot.eid]);
    expect(carried(w, Position)).toBe(1);
  });

  it("exposes the old-id to restored-entity mapping so callers can rebind", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    const child = w.entity().add(ChildOf, root).add(Hull);
    const childEid = child.eid;
    const rootEid = root.eid;
    other.component(Hull).on("add", () => {
      throw new Error("destination exploded");
    });

    const error = captureError(() => w.moveSubtree(root, other)) as MoveSubtreeError;
    const restoredChild = error.restored.get(childEid)!;
    const restoredRoot = error.restored.get(rootEid)!;

    expect(restoredChild).toBeDefined();
    expect(restoredRoot).toBeDefined();
    expect(restoredChild.eid).not.toBe(childEid);
    expect(restoredRoot.eid).not.toBe(rootEid);
    expect(root.destroyed).toBe(true);
    expect(restoredChild.get(Hull)!.hp).toBe(100);
    expect(targets(restoredChild, ChildOf)).toEqual([restoredRoot.eid]);
  });

  it("never carries an inbound edge into the rollback", () => {
    const w = makeWorld();
    const other = makeWorld();
    const outside = w.entity().add(Position);
    const root = w.entity().add(Position);
    outside.add(TetheredTo, root);
    other.component(Position).on("add", () => {
      throw new Error("destination exploded");
    });

    const error = captureError(() => w.moveSubtree(root, other)) as MoveSubtreeError;
    const restoredRoot = error.restored.get(root.eid)!;

    expect(restoredRoot).toBeDefined();
    expect(outside.targets(TetheredTo)).toHaveLength(0);
  });

  it("restores the source forest for a multi-root move", () => {
    const w = makeWorld();
    const other = makeWorld();
    const a = w.entity().add(Position);
    w.entity().add(Velocity).add(ChildOf, a);
    other.component(Velocity).on("add", () => {
      throw new Error("nope");
    });

    const error = captureError(() => w.moveSubtree([a], other)) as MoveSubtreeError;

    expect((error.cause as Error).message).toBe("nope");
    expect(carried(w, Position)).toBe(1);
    expect(carried(w, Velocity)).toBe(1);
    expect(carried(other, Position)).toBe(0);
  });

  it("rejects the same world as both source and destination", () => {
    const w = makeWorld();

    expect(() => w.moveSubtree(w.entity(), w)).toThrow(/destination world other than the source/);
  });

  it("throws while the source world is deferred", () => {
    const w = makeWorld();
    const other = makeWorld();
    w.beginDefer();

    expect(() => w.moveSubtree(w.entity(), other)).toThrow(
      /moveSubtree cannot run while the world is deferred/
    );
  });

  it("throws while the destination world is deferred", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity().add(Position);
    other.beginDefer();

    expect(() => w.moveSubtree(root, other)).toThrow(
      /moveSubtree cannot run while the world is deferred/
    );
    expect(root.destroyed).toBe(false);
  });

  it("applies DontSnapshot exclusions during a move", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.component(Session).snapshotPolicy(DontSnapshot));
    const root = w.entity().add(Position).add(Session);

    const restored = w.moveSubtree(root, other).roots[0];

    expect(restored.has(Session)).toBe(false);
    expect(restored.has(Position)).toBe(true);
  });

  it("moves a forest with no components", () => {
    const w = makeWorld();
    const other = makeWorld();
    const root = w.entity();
    const child = w.entity().add(ChildOf, root);

    const result = w.moveSubtree(root, other);

    expect(result.roots[0].has(ChildOf)).toBe(false);
    expect(targets(result.entities.get(child.eid)!, ChildOf)).toEqual([result.roots[0].eid]);
  });
});

describe("snapshot — package surface", () => {
  it("exports the policy values at runtime", async () => {
    const mod = await import("../src/index.js");
    ["ClonePublic", "CustomSnapshot", "DontSnapshot", "OnSnapshot", "SnapshotModule"].forEach(
      (name) => expect(mod).toHaveProperty(name)
    );
  });

  it("exposes the three operations on World", () => {
    const w = makeWorld();
    const other = makeWorld();

    expect(typeof w.snapshotSubtree).toBe("function");
    expect(typeof w.restoreSubtree).toBe("function");
    expect(typeof w.moveSubtree).toBe("function");
    expect(w.restoreSubtree(other, w.snapshotSubtree(w.entity())).roots[0].world).toBe(other);
  });
});

describe("snapshot — Exclusive", () => {
  it("restores an Exclusive component without disturbing its siblings", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.setExclusiveComponents(Position, Velocity));
    const root = w.entity().add(Position);
    const child = w.entity().add(Velocity).add(ChildOf, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(result.roots[0].has(Position)).toBe(true);
    expect(result.roots[0].has(Velocity)).toBe(false);
    expect(result.entities.get(child.eid)!.has(Velocity)).toBe(true);
    expect(child.has(Velocity)).toBe(true);
  });

  it("restores a relationship restricted to one target", () => {
    const w = makeWorld();
    const other = makeWorld();
    [w, other].forEach((world) => world.component(Carries).add(Exclusive));
    const root = w.entity();
    const child = w.entity().add(ChildOf, root).add(Carries, root);

    const result = w.restoreSubtree(other, w.snapshotSubtree(root));

    expect(targets(result.entities.get(child.eid)!, Carries)).toEqual([result.roots[0].eid]);
  });
});
