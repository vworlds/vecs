import { describe, expect, it } from "vitest";
import { _compile, getDSLKey, simplifyQueryDSL, type QueryDSL } from "../src/dsl.js";
import { ChildOf, Relationship, World } from "../src/index.js";
import { Entity } from "../src/entity/index.js";
import { Bitset } from "../src/util/bitset.js";

class Position {
  x = 0;
  y = 0;
}

class Velocity {
  vx = 0;
  vy = 0;
}

class Sprite {}
class Container {}
class FriendOf extends Relationship {}

const POSITION_EID = 100;
const VELOCITY_EID = 101;
const SPRITE_EID = 102;
const CONTAINER_EID = 103;
const FRIEND_OF_EID = 104;

describe("Query DSL simplification", () => {
  function registeredWorld(): World {
    const world = new World();
    world.component(Position, POSITION_EID);
    world.component(Velocity, VELOCITY_EID);
    world.component(Sprite, SPRITE_EID);
    world.component(Container, CONTAINER_EID);
    world.component(FriendOf, FRIEND_OF_EID);
    return world;
  }

  it("flattens nested all component requirements into array shorthand", () => {
    const world = registeredWorld();

    expect(
      simplifyQueryDSL(
        {
          all: [{ all: [{ all: [Position, Velocity] }, Sprite] }, Container],
        },
        world
      )
    ).toEqual([POSITION_EID, VELOCITY_EID, SPRITE_EID, CONTAINER_EID]);
  });

  it("flattens nested any expressions without converting them to all shorthand", () => {
    const world = registeredWorld();

    expect(
      simplifyQueryDSL(
        {
          any: [{ any: [Position, Velocity] }, Sprite],
        },
        world
      )
    ).toEqual({ any: [POSITION_EID, VELOCITY_EID, SPRITE_EID] });
  });

  it("unwraps singleton operators", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ all: [{ all: [Position] }] }, world)).toBe(POSITION_EID);
    expect(simplifyQueryDSL({ any: [{ any: [Velocity] }] }, world)).toBe(VELOCITY_EID);
  });

  it("simplifies children inside not", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ not: { all: [Position, Velocity] } }, world)).toEqual({
      not: [POSITION_EID, VELOCITY_EID],
    });
  });

  it("preserves explicit custom predicate functions in all expressions", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ all: [Position, { test: predicate }] }, world)).toEqual({
      all: [POSITION_EID, { test: predicate }],
    });
  });

  it("removes identity terms and preserves absorbing terms", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([], world)).toBe(true);
    expect(simplifyQueryDSL({ all: [] }, world)).toBe(true);
    expect(simplifyQueryDSL({ any: [] }, world)).toBe(false);
    expect(simplifyQueryDSL({ all: [[], Position] }, world)).toBe(POSITION_EID);
    expect(simplifyQueryDSL({ any: [{ any: [] }, Position] }, world)).toBe(POSITION_EID);
    expect(simplifyQueryDSL({ all: [{ any: [] }, Position] }, world)).toBe(false);
    expect(simplifyQueryDSL({ any: [[], Position] }, world)).toBe(true);
    expect(simplifyQueryDSL({ all: [Position, true] }, world)).toBe(POSITION_EID);
    expect(simplifyQueryDSL({ all: [Position, false] }, world)).toBe(false);
    expect(simplifyQueryDSL({ any: [Position, true] }, world)).toBe(true);
    expect(simplifyQueryDSL({ any: [Position, false] }, world)).toBe(POSITION_EID);
  });

  it("sorts numeric component requirements", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([2, 1], world)).toEqual([1, 2]);
    expect(simplifyQueryDSL({ all: [2, 1] }, world)).toEqual([1, 2]);
    expect(simplifyQueryDSL({ only: [2, 1] }, world)).toEqual({ only: [1, 2] });
    expect(simplifyQueryDSL({ only: [1] }, world)).toEqual({ only: 1 });
  });

  it("deduplicates sorted component requirements", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([Velocity, Position, Position], world)).toEqual([
      POSITION_EID,
      VELOCITY_EID,
    ]);
    expect(simplifyQueryDSL({ all: [Position, Velocity, Position] }, world)).toEqual([
      POSITION_EID,
      VELOCITY_EID,
    ]);
    expect(simplifyQueryDSL({ any: [Velocity, Position, Velocity] }, world)).toEqual({
      any: [POSITION_EID, VELOCITY_EID],
    });
    expect(simplifyQueryDSL({ only: [Velocity, Position, Velocity] }, world)).toEqual({
      only: [POSITION_EID, VELOCITY_EID],
    });
    expect(getDSLKey({ all: [Position, Velocity, Position] }, world)).toBe(
      getDSLKey({ all: [Position, Velocity] }, world)
    );
  });

  it("converts component classes to sorted numeric requirements when world is supplied", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([Velocity, Position], world)).toEqual([POSITION_EID, VELOCITY_EID]);
    expect(simplifyQueryDSL({ all: [Velocity, Position] }, world)).toEqual([
      POSITION_EID,
      VELOCITY_EID,
    ]);
    expect(simplifyQueryDSL({ only: [Velocity, Position] }, world)).toEqual({
      only: [POSITION_EID, VELOCITY_EID],
    });
  });

  it("sorts any terms after converting component classes to type ids", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ any: [Velocity, Position] }, world)).toEqual({
      any: [POSITION_EID, VELOCITY_EID],
    });
    expect(simplifyQueryDSL({ any: [{ any: [Sprite, Velocity] }, Position] }, world)).toEqual({
      any: [POSITION_EID, VELOCITY_EID, SPRITE_EID],
    });
  });

  it("keeps custom predicate functions while sorting known component terms", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ any: [Velocity, { test: predicate }, Position] }, world)).toEqual({
      any: [POSITION_EID, VELOCITY_EID, { test: predicate }],
    });
  });

  it("returns the same DSL key for equivalent component expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey([Velocity, Position], world)).toBe(
      getDSLKey({ all: [Position, Velocity] }, world)
    );
    expect(getDSLKey({ any: [Velocity, Position] }, world)).toBe(
      getDSLKey({ any: [Position, Velocity] }, world)
    );
    expect(getDSLKey([Velocity, Position], world)).toBe(1491372455);
    expect(getDSLKey({ any: [Velocity, Position] }, world)).toBe(4279429284);
  });

  it("returns different DSL keys for different expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey(Position, world)).not.toBe(getDSLKey(Velocity, world));
    expect(getDSLKey([Position, Velocity], world)).not.toBe(
      getDSLKey({ any: [Position, Velocity] }, world)
    );
    expect(getDSLKey(Position, world)).toBe(1272356232);
    expect(getDSLKey(Velocity, world)).toBe(2412984061);
    expect(getDSLKey([Position, Velocity], world)).toBe(1491372455);
    expect(getDSLKey({ any: [Position, Velocity] }, world)).toBe(4279429284);
  });

  it("keys custom predicates by function identity", () => {
    const world = registeredWorld();
    const predicate = () => true;
    const otherPredicate = () => true;

    expect(getDSLKey({ all: [Position, { test: predicate }] }, world)).toBe(
      getDSLKey({ all: [{ test: predicate }, Position] }, world)
    );
    expect(getDSLKey({ all: [Position, { test: predicate }] }, world)).not.toBe(
      getDSLKey({ all: [Position, { test: otherPredicate }] }, world)
    );
    expect(getDSLKey({ all: [Position, { test: predicate }] }, world)).toBe(1471199382);
    expect(getDSLKey({ all: [Position, { test: otherPredicate }] }, world)).toBe(3913731301);
  });

  it("simplifies target by resolving the relationship and inner DSL", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ target: [FriendOf, { all: [Velocity, Position] }] }, world)).toEqual({
      target: [FRIEND_OF_EID, [POSITION_EID, VELOCITY_EID]],
    });
    expect(simplifyQueryDSL({ target: [FriendOf, false] }, world)).toBe(false);
  });

  it("simplifies source by resolving the relationship and inner DSL", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ source: [FriendOf, { all: [Velocity, Position] }] }, world)).toEqual({
      source: [FRIEND_OF_EID, [POSITION_EID, VELOCITY_EID]],
    });
    expect(simplifyQueryDSL({ source: [FriendOf, false] }, world)).toBe(false);
  });

  it("simplifies parent and children through the built-in ChildOf relationship", () => {
    const world = registeredWorld();
    const childOfEid = world.entity(ChildOf).eid;

    expect(simplifyQueryDSL({ parent: { all: [Velocity, Position] } }, world)).toEqual({
      target: [childOfEid, [POSITION_EID, VELOCITY_EID]],
    });
    expect(simplifyQueryDSL({ children: Position }, world)).toEqual({
      source: [childOfEid, POSITION_EID],
    });
  });

  it("returns the same DSL key for equivalent target expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey({ target: [FriendOf, { all: [Velocity, Position] }] }, world)).toBe(
      getDSLKey({ target: [FRIEND_OF_EID, [Position, Velocity]] }, world)
    );
  });

  it("rejects target when the ref is not a relationship", () => {
    const world = registeredWorld();

    expect(() => simplifyQueryDSL({ target: [Position, true] }, world)).toThrow(
      "Component Position is not a Relationship"
    );
  });

  it("rejects source when the ref is not a relationship", () => {
    const world = registeredWorld();

    expect(() => simplifyQueryDSL({ source: [Position, true] }, world)).toThrow(
      "Component Position is not a Relationship"
    );
  });
});

describe("Query DSL compilation", () => {
  function wideWorld(): World {
    const world = new World();
    for (let i = 3; i <= 200; i++) {
      if (world.getEntity(i) !== undefined) {
        continue;
      }
      class C {}
      Object.defineProperty(C, "name", { value: `C${i}` });
      world.component(C, i);
    }
    return world;
  }

  function entityWithComponents(world: World, typeIds: number[]): Entity {
    const e = world.entity();
    for (const t of typeIds) {
      const componentMeta = world.entity(t)!.meta;
      e.componentBitmask.addBit(componentMeta.bitPtr);
    }
    return e;
  }

  function exhaustiveEntities(world: World, candidateTypes: number[]): Entity[] {
    // Generate every subset of `candidateTypes` (limited to keep the test
    // tractable). Each subset becomes a synthetic entity bitset that we
    // check against the compiled predicate.
    const entities: Entity[] = [];
    const count = candidateTypes.length;
    const total = 1 << count;
    for (let mask = 0; mask < total; mask++) {
      const subset: number[] = [];
      for (let i = 0; i < count; i++) {
        if ((mask & (1 << i)) !== 0) {
          subset.push(candidateTypes[i]);
        }
      }
      entities.push(entityWithComponents(world, subset));
    }
    return entities;
  }

  // Run a battery of synthetic entities against `q` and assert that the
  // compiled predicate agrees with a reference check that performs the
  // same containment test using `Bitset.hasBitset` directly.
  function assertCompiledMatches(world: World, q: QueryDSL, candidateTypes: number[]): void {
    const compiled = _compile(world, q);
    const reference = referencePredicate(world, q);
    for (const e of exhaustiveEntities(world, candidateTypes)) {
      const got = compiled(e);
      const want = reference(e);
      if (got !== want) {
        throw new Error(
          `compiled=${got} but reference=${want} for entity bits=[${e.componentBitmask
            .indices()
            .join(",")}] dsl=${JSON.stringify(q)}`
        );
      }
    }
  }

  // Build a reference predicate by interpreting the simplified DSL with
  // `Bitset.hasBitset` so we have an independent oracle for the compiled
  // form. We do not exercise custom-function nodes here; the
  // compiled form delegates those to the same runtime helpers regardless.
  function referencePredicate(world: World, q: QueryDSL): (e: Entity) => boolean {
    const s = simplifyQueryDSL(q, world);
    return (e: Entity): boolean => evalReference(world, s, e);
  }

  function evalReference(world: World, q: QueryDSL, e: Entity): boolean {
    if (typeof q === "boolean") {
      return q;
    }
    if (typeof q === "number") {
      return e.componentBitmask.hasBitset(maskOf([q]));
    }
    if (typeof q === "function") {
      try {
        const componentEntity = world.entity(q as unknown as new (...args: never[]) => object);
        return e.componentBitmask.hasBitset(maskOf([componentEntity.eid]));
      } catch {
        throw new Error("reference evaluator does not handle custom predicates");
      }
    }
    if (q instanceof Array) {
      return e.componentBitmask.hasBitset(maskOf(q as number[]));
    }
    if ("only" in q) {
      const v = q.only;
      return e.componentBitmask.equal(maskOf(v instanceof Array ? (v as number[]) : [v as number]));
    }
    if ("all" in q) {
      return q.all.every((sq) => evalReference(world, sq, e));
    }
    if ("any" in q) {
      return q.any.some((sq) => evalReference(world, sq, e));
    }
    if ("not" in q) {
      return !evalReference(world, q.not, e);
    }
    if ("test" in q) {
      return q.test(e);
    }
    throw new Error("unrecognized term in reference evaluator");
  }

  function maskOf(types: number[]): Bitset {
    const b = new Bitset();
    types.forEach((t) => b.add(t));
    return b;
  }

  it("matches reference semantics for a single component", () => {
    const world = wideWorld();
    assertCompiledMatches(world, 1, [1, 2, 3]);
  });

  it("matches reference semantics for boolean literals", () => {
    const world = wideWorld();

    assertCompiledMatches(world, true, [1, 2, 3]);
    assertCompiledMatches(world, false, [1, 2, 3]);
    assertCompiledMatches(world, [], [1, 2, 3]);
    assertCompiledMatches(world, { any: [] }, [1, 2, 3]);
  });

  it("matches reference semantics for all components in the same word", () => {
    const world = wideWorld();
    assertCompiledMatches(world, [1, 2, 3], [1, 2, 3, 4]);
  });

  it("matches reference semantics for all across multiple words", () => {
    const world = wideWorld();
    // 1 sits in word 0, 67 in word 2, 130 in word 4 — explicitly skips
    // intermediate zero words to exercise the codegen's word-skipping.
    assertCompiledMatches(world, [1, 67, 130], [1, 65, 67, 130, 131]);
  });

  it("matches reference semantics for nested all/any/not", () => {
    const world = wideWorld();
    assertCompiledMatches(world, { all: [1, { any: [2, 3] }, { not: 4 }] }, [1, 2, 3, 4]);
  });

  it("matches reference semantics for queries with high-bit components", () => {
    const world = wideWorld();
    // Bit 31 in word 0 + bit 0 in word 4 — exercises the negative int32
    // literal emitted by _compileSubsetCheck.
    assertCompiledMatches(world, [31, 128], [30, 31, 127, 128, 129]);
  });

  it("matches reference semantics for only (which is not inlined)", () => {
    const world = wideWorld();
    assertCompiledMatches(world, { only: [1, 2] }, [1, 2, 3]);
  });

  it("inlines word values into the compiled predicate source", () => {
    const world = wideWorld();
    const compiled = _compile(world, [1, 2]);
    // Two consecutive bits in word 0 -> bitmask 0b110 = 6.
    expect(compiled.toString()).toContain("&6)===6");
    expect(compiled.toString()).not.toContain("hasBitset");
  });

  it("falls back to the closure-call path for only (equal)", () => {
    const world = wideWorld();
    const compiled = _compile(world, { only: [1, 2] });
    expect(compiled.toString()).toContain("equal(m0)");
  });

  it("matches target by testing the relationship target", () => {
    const world = new World();
    world.component(Position);
    world.component(FriendOf);
    const target = world.entity().add(Position);
    const candidate = world.entity().add(FriendOf, target);
    const unrelated = world.entity();

    const compiled = _compile(world, { target: [FriendOf, Position] });

    expect(compiled(candidate)).toBe(true);
    expect(compiled(unrelated)).toBe(false);
  });

  it("matches source by testing relationship children existentially", () => {
    const world = new World();
    world.component(Position);
    world.component(FriendOf);
    const parent = world.entity();
    const miss = world.entity();
    world.entity().add(FriendOf, parent).add(Position);
    world.entity().add(FriendOf, miss);

    const compiled = _compile(world, { source: [FriendOf, Position] });

    expect(compiled(parent)).toBe(true);
    expect(compiled(miss)).toBe(false);
  });
});
