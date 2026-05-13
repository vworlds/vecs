import { describe, expect, it } from "vitest";
import { getDSLKey, simplifyQueryDSL } from "../src/dsl.js";
import { World } from "../src/world.js";

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

describe("Query DSL simplification", () => {
  function registeredWorld(): World {
    const world = new World();
    world.registerComponent(Position, 0);
    world.registerComponent(Velocity, 1);
    world.registerComponent(Sprite, 2);
    world.registerComponent(Container, 3);
    world.registerComponent(Player, 4);
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
    ).toEqual([0, 1, 2, 3]);
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
    ).toEqual({ OR: [0, 1, 2] });
  });

  it("unwraps singleton operators", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ AND: [{ AND: [Position] }] }, world)).toBe(0);
    expect(simplifyQueryDSL({ OR: [{ OR: [Velocity] }] }, world)).toBe(1);
  });

  it("simplifies children inside NOT and PARENT", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ NOT: { AND: [Position, Velocity] } }, world)).toEqual({
      NOT: [0, 1],
    });
    expect(simplifyQueryDSL({ PARENT: { AND: [Player, Container] } }, world)).toEqual({
      PARENT: [3, 4],
    });
  });

  it("preserves custom predicate functions in AND expressions", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ AND: [Position, predicate] }, world)).toEqual({
      AND: [0, predicate],
    });
  });

  it("removes identity terms and preserves absorbing terms", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ AND: [[], Position] }, world)).toBe(0);
    expect(simplifyQueryDSL({ OR: [{ OR: [] }, Position] }, world)).toBe(0);
    expect(simplifyQueryDSL({ AND: [{ OR: [] }, Position] }, world)).toEqual({ OR: [] });
    expect(simplifyQueryDSL({ OR: [[], Position] }, world)).toEqual([]);
  });

  it("sorts numeric component requirements", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([1, 0], world)).toEqual([0, 1]);
    expect(simplifyQueryDSL({ AND: [1, 0] }, world)).toEqual([0, 1]);
    expect(simplifyQueryDSL({ HAS_ONLY: [1, 0] }, world)).toEqual({ HAS_ONLY: [0, 1] });
    expect(simplifyQueryDSL({ HAS_ONLY: [1] }, world)).toEqual({ HAS_ONLY: 1 });
  });

  it("converts component classes to sorted numeric requirements when world is supplied", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL([Velocity, Position], world)).toEqual([0, 1]);
    expect(simplifyQueryDSL({ HAS: [Velocity, Position] }, world)).toEqual([0, 1]);
    expect(simplifyQueryDSL({ AND: [Velocity, Position] }, world)).toEqual([0, 1]);
    expect(simplifyQueryDSL({ HAS_ONLY: [Velocity, Position] }, world)).toEqual({
      HAS_ONLY: [0, 1],
    });
  });

  it("sorts OR terms after converting component classes to type ids", () => {
    const world = registeredWorld();

    expect(simplifyQueryDSL({ OR: [Velocity, Position] }, world)).toEqual({ OR: [0, 1] });
    expect(simplifyQueryDSL({ OR: [{ OR: [Sprite, Velocity] }, Position] }, world)).toEqual({
      OR: [0, 1, 2],
    });
  });

  it("keeps custom predicate functions while sorting known component terms", () => {
    const world = registeredWorld();
    const predicate = () => true;

    expect(simplifyQueryDSL({ OR: [Velocity, predicate, Position] }, world)).toEqual({
      OR: [0, 1, predicate],
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
  });

  it("returns different DSL keys for different expressions", () => {
    const world = registeredWorld();

    expect(getDSLKey(Position, world)).not.toBe(getDSLKey(Velocity, world));
    expect(getDSLKey([Position, Velocity], world)).not.toBe(
      getDSLKey({ OR: [Position, Velocity] }, world)
    );
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
  });
});
