import { describe, expect, it } from "vitest";
import { simplifyQueryDSL } from "../src/index.js";

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
  it("flattens nested AND component requirements into array shorthand", () => {
    expect(
      simplifyQueryDSL({
        AND: [{ AND: [{ AND: [Position, Velocity] }, Sprite] }, Container],
      })
    ).toEqual([Position, Velocity, Sprite, Container]);
  });

  it("flattens nested OR expressions without converting them to AND shorthand", () => {
    expect(
      simplifyQueryDSL({
        OR: [{ OR: [Position, Velocity] }, Sprite],
      })
    ).toEqual({ OR: [Position, Velocity, Sprite] });
  });

  it("unwraps singleton operators", () => {
    expect(simplifyQueryDSL({ AND: [{ AND: [Position] }] })).toBe(Position);
    expect(simplifyQueryDSL({ OR: [{ OR: [Velocity] }] })).toBe(Velocity);
  });

  it("simplifies children inside NOT and PARENT", () => {
    expect(simplifyQueryDSL({ NOT: { AND: [Position, Velocity] } })).toEqual({
      NOT: [Position, Velocity],
    });
    expect(simplifyQueryDSL({ PARENT: { AND: [Player, Container] } })).toEqual({
      PARENT: [Player, Container],
    });
  });

  it("preserves custom predicate functions in AND expressions", () => {
    const predicate = () => true;

    expect(simplifyQueryDSL({ AND: [Position, predicate] })).toEqual({
      AND: [Position, predicate],
    });
  });

  it("removes identity terms and preserves absorbing terms", () => {
    expect(simplifyQueryDSL({ AND: [[], Position] })).toBe(Position);
    expect(simplifyQueryDSL({ OR: [{ OR: [] }, Position] })).toBe(Position);
    expect(simplifyQueryDSL({ AND: [{ OR: [] }, Position] })).toEqual({ OR: [] });
    expect(simplifyQueryDSL({ OR: [[], Position] })).toEqual([]);
  });
});
