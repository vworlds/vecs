import { describe, expect, it } from "vitest";
import { _compile, getDSLKey, simplifyQueryDSL, type QueryDSL } from "../src/dsl.js";
import { Relationship, World } from "../src/index.js";
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
class Player {}
class FriendOf extends Relationship {}

describe("Query DSL simplification", () => {
  function registeredWorld(): World {
    const world = new World();
    world.component(Position, 10);
    world.component(Velocity, 11);
    world.component(Sprite, 12);
    world.component(Container, 13);
    world.component(Player, 14);
    world.component(FriendOf, 15);
    return world;
  }

  it("flattens nested AND component requirements into array shorthand", () => {
    const world = registeredWorld();

    expect(
      simplifyQueryDSL(
        {
          AND: [{ AND: [{ AND: [Position, Velocity] }, Sprite] }, Container],
        },
        world
      )
    ).toEqual([10, 11, 12, 13]);
  });

  it("flattens nested OR expressions without converting them to AND shorthand", () => {
    const world = registeredWorld();

    expect(
      simplifyQueryDSL(
        {
          OR: [{ OR: [Position, Velocity] }, Sprite],
        },
        world
      )
    ).toEqual({ OR: [10, 11, 12] });
  });

  it("unwraps singleton operators", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ AND: [{ AND: [Position] }] }, world)).toBe(10);
    expect(simplifyQueryDSL({ OR: [{ OR: [Velocity] }] }, world)).toBe(11);
  });

  it("simplifies children inside NOT and PARENT", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ NOT: { AND: [Position, Velocity] } }, world)).toEqual({
      NOT: [10, 11],
    });
    expect(simplifyQueryDSL({ PARENT: { AND: [Player, Container] } }, world)).toEqual({
      PARENT: [13, 14],
    });
  });

  it("preserves custom predicate functions in AND expressions", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ AND: [Position, predicate] }, world)).toEqual({
      AND: [10, predicate],
    });
  });

  it("removes identity terms and preserves absorbing terms", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([], world)).toBe(true);
    expect(simplifyQueryDSL({ AND: [] }, world)).toBe(true);
    expect(simplifyQueryDSL({ OR: [] }, world)).toBe(false);
    expect(simplifyQueryDSL({ AND: [[], Position] }, world)).toBe(10);
    expect(simplifyQueryDSL({ OR: [{ OR: [] }, Position] }, world)).toBe(10);
    expect(simplifyQueryDSL({ AND: [{ OR: [] }, Position] }, world)).toBe(false);
    expect(simplifyQueryDSL({ OR: [[], Position] }, world)).toBe(true);
    expect(simplifyQueryDSL({ AND: [Position, true] }, world)).toBe(10);
    expect(simplifyQueryDSL({ AND: [Position, false] }, world)).toBe(false);
    expect(simplifyQueryDSL({ OR: [Position, true] }, world)).toBe(true);
    expect(simplifyQueryDSL({ OR: [Position, false] }, world)).toBe(10);
  });

  it("sorts numeric component requirements", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([2, 1], world)).toEqual([1, 2]);
    expect(simplifyQueryDSL({ AND: [2, 1] }, world)).toEqual([1, 2]);
    expect(simplifyQueryDSL({ HAS_ONLY: [2, 1] }, world)).toEqual({ HAS_ONLY: [1, 2] });
    expect(simplifyQueryDSL({ HAS_ONLY: [1] }, world)).toEqual({ HAS_ONLY: 1 });
  });

  it("converts component classes to sorted numeric requirements when world is supplied", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([Velocity, Position], world)).toEqual([10, 11]);
    expect(simplifyQueryDSL({ HAS: [Velocity, Position] }, world)).toEqual([10, 11]);
    expect(simplifyQueryDSL({ AND: [Velocity, Position] }, world)).toEqual([10, 11]);
    expect(simplifyQueryDSL({ HAS_ONLY: [Velocity, Position] }, world)).toEqual({
      HAS_ONLY: [10, 11],
    });
  });

  it("converts relationship classes to numeric REL requirements", () => {
    const world = registeredWorld();
    const target = world.entity();

    expect(simplifyQueryDSL({ REL: [FriendOf, target] }, world)).toEqual({
      REL: [15, target],
    });
  });

  it("rejects REL requirements for non-relationship components", () => {
    const world = registeredWorld();
    const target = world.entity();

    expect(() => simplifyQueryDSL({ REL: [Position, target] }, world)).toThrow(
      /not a Relationship/
    );
  });

  it("sorts OR terms after converting component classes to type ids", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ OR: [Velocity, Position] }, world)).toEqual({ OR: [10, 11] });
    expect(simplifyQueryDSL({ OR: [{ OR: [Sprite, Velocity] }, Position] }, world)).toEqual({
      OR: [10, 11, 12],
    });
  });

  it("keeps custom predicate functions while sorting known component terms", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ OR: [Velocity, predicate, Position] }, world)).toEqual({
      OR: [10, 11, predicate],
    });
  });

  it("returns the same DSL key for equivalent component expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey([Velocity, Position], world)).toBe(
      getDSLKey({ AND: [{ HAS: Position }, Velocity] }, world)
    );
    expect(getDSLKey({ OR: [Velocity, Position] }, world)).toBe(
      getDSLKey({ OR: [Position, Velocity] }, world)
    );
    expect(getDSLKey([Velocity, Position], world)).toBe(191430977);
    expect(getDSLKey({ OR: [Velocity, Position] }, world)).toBe(590044505);
  });

  it("returns different DSL keys for different expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey(Position, world)).not.toBe(getDSLKey(Velocity, world));
    expect(getDSLKey([Position, Velocity], world)).not.toBe(
      getDSLKey({ OR: [Position, Velocity] }, world)
    );
    expect(getDSLKey(Position, world)).toBe(1990859998);
    expect(getDSLKey(Velocity, world)).toBe(1923602427);
    expect(getDSLKey([Position, Velocity], world)).toBe(191430977);
    expect(getDSLKey({ OR: [Position, Velocity] }, world)).toBe(590044505);
  });

  it("keys custom predicates by function identity", () => {
    const world = registeredWorld();
    const predicate = () => true;
    const otherPredicate = () => true;

    expect(getDSLKey({ AND: [Position, predicate] }, world)).toBe(
      getDSLKey({ AND: [predicate, Position] }, world)
    );
    expect(getDSLKey({ AND: [Position, predicate] }, world)).not.toBe(
      getDSLKey({ AND: [Position, otherPredicate] }, world)
    );
    expect(getDSLKey({ AND: [Position, predicate] }, world)).toBe(563208872);
    expect(getDSLKey({ AND: [Position, otherPredicate] }, world)).toBe(3001038715);
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
      const meta = world.entity(t)!.ownMeta;
      e.componentBitmask.addBit(meta.bitPtr);
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
  // form. We do not exercise PARENT / custom-function nodes here; the
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
    if ("HAS" in q) {
      return evalReference(world, q.HAS, e);
    }
    if ("HAS_ONLY" in q) {
      const v = q.HAS_ONLY;
      return e.componentBitmask.equal(maskOf(v instanceof Array ? (v as number[]) : [v as number]));
    }
    if ("AND" in q) {
      return q.AND.every((sq) => evalReference(world, sq, e));
    }
    if ("OR" in q) {
      return q.OR.some((sq) => evalReference(world, sq, e));
    }
    if ("NOT" in q) {
      return !evalReference(world, q.NOT, e);
    }
    if ("PARENT" in q) {
      return e.parent ? evalReference(world, q.PARENT, e.parent) : false;
    }
    if ("REL" in q) {
      const [component, target] = q.REL;
      return (
        (e._get(world.entity(component).eid) as { target?: Entity } | undefined)?.target === target
      );
    }
    throw new Error("unrecognized term in reference evaluator");
  }

  function maskOf(types: number[]): Bitset {
    const b = new Bitset();
    types.forEach((t) => b.add(t));
    return b;
  }

  it("matches reference semantics for a single HAS", () => {
    const world = wideWorld();
    assertCompiledMatches(world, 1, [1, 2, 3]);
  });

  it("matches reference semantics for boolean literals", () => {
    const world = wideWorld();

    assertCompiledMatches(world, true, [1, 2, 3]);
    assertCompiledMatches(world, false, [1, 2, 3]);
    assertCompiledMatches(world, [], [1, 2, 3]);
    assertCompiledMatches(world, { OR: [] }, [1, 2, 3]);
  });

  it("matches reference semantics for AND of components in the same word", () => {
    const world = wideWorld();
    assertCompiledMatches(world, [1, 2, 3], [1, 2, 3, 4]);
  });

  it("matches reference semantics for AND across multiple words", () => {
    const world = wideWorld();
    // 1 sits in word 0, 67 in word 2, 130 in word 4 — explicitly skips
    // intermediate zero words to exercise the codegen's word-skipping.
    assertCompiledMatches(world, [1, 67, 130], [1, 65, 67, 130, 131]);
  });

  it("matches reference semantics for nested AND/OR/NOT", () => {
    const world = wideWorld();
    assertCompiledMatches(world, { AND: [1, { OR: [2, 3] }, { NOT: 4 }] }, [1, 2, 3, 4]);
  });

  it("matches reference semantics for queries with high-bit components", () => {
    const world = wideWorld();
    // Bit 31 in word 0 + bit 0 in word 4 — exercises the negative int32
    // literal emitted by _compileSubsetCheck.
    assertCompiledMatches(world, [31, 128], [30, 31, 127, 128, 129]);
  });

  it("matches reference semantics for HAS_ONLY (which is not inlined)", () => {
    const world = wideWorld();
    assertCompiledMatches(world, { HAS_ONLY: [1, 2] }, [1, 2, 3]);
  });

  it("inlines word values into the compiled predicate source", () => {
    const world = wideWorld();
    const compiled = _compile(world, [1, 2]);
    // Two consecutive bits in word 0 -> bitmask 0b110 = 6.
    expect(compiled.toString()).toContain("&6)===6");
    expect(compiled.toString()).not.toContain("hasBitset");
  });

  it("falls back to the closure-call path for HAS_ONLY (equal)", () => {
    const world = wideWorld();
    const compiled = _compile(world, { HAS_ONLY: [1, 2] });
    expect(compiled.toString()).toContain("equal(m0)");
  });
});
