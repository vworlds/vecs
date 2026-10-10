import { describe, expect, it } from "vitest";
import { DEFAULT_ID_REUSE_WAIT_FRAMES } from "@vworlds/vecs";
import { wireType } from "@vworlds/vecs-wire";
import { HISTORY_LENGTH } from "../src/history.js";
import { Networked, ServerWorld, type ServerWorldOptions } from "../src/index.js";

// A server frees the id of a destroyed entity into its `entity` pool, and the pool holds it for a
// number of frames before another entity can take it. That wait has to outlast the history: once a
// session's history no longer holds the frame that removed the old entity, a client that missed the
// removal is rebuilt from a baseline instead of being sent a delta that would have to tell two
// entities with one id apart.

class Position {
  @wireType("i32")
  public x = 0;
}

function newWorld(options: ServerWorldOptions = {}): ServerWorld {
  return new ServerWorld({ networkComponents: [Position], ...options });
}

/** The wait the `entity` pool was configured with. */
function configuredWait(world: ServerWorld): number | undefined {
  return world.pools.find((pool) => pool.name === "entity")?.reuseWaitFrames;
}

/**
 * Destroy a replicated entity, then count the frames until a new entity is given its id. Each
 * candidate is destroyed again so it does not hold the pool up.
 */
function framesUntilReuse(world: ServerWorld, maxFrames: number): number | undefined {
  const entity = world.entity().add(Networked).set(Position, { x: 1 });
  const eid = entity.eid;
  entity.destroy();
  for (let frame = 1; frame <= maxFrames; frame++) {
    world.progress(frame, 1);
    const candidate = world.entity();
    const reused = candidate.eid === eid;
    candidate.destroy();
    if (reused) {
      return frame;
    }
  }
  return undefined;
}

describe("a ServerWorld's id quarantine", () => {
  it("is one frame more than the default history: 65 frames", () => {
    const world = newWorld();

    expect(HISTORY_LENGTH + 1).toBe(65);
    expect(configuredWait(world)).toBe(HISTORY_LENGTH + 1);
    expect(framesUntilReuse(world, 80)).toBe(65);
  });

  it.each([
    [2, DEFAULT_ID_REUSE_WAIT_FRAMES],
    [15, DEFAULT_ID_REUSE_WAIT_FRAMES],
    [16, 17],
    [30, 31],
    [200, 201],
  ])("with %i frames of history is %i frames", (historyFrames, expected) => {
    const world = newWorld({ historyFrames });

    expect(configuredWait(world)).toBe(expected);
    expect(framesUntilReuse(world, expected + 5)).toBe(expected);
  });

  it("is always longer than the history", () => {
    for (const historyFrames of [2, 3, 10, 16, 17, 64, 65, 128]) {
      expect(configuredWait(newWorld({ historyFrames }))).toBeGreaterThan(historyFrames);
    }
  });

  it("is the wait of the one pool a server allocates its entities from", () => {
    const world = newWorld();

    expect(world.pools.map((pool) => pool.name)).toEqual(["component", "module", "entity"]);
    expect(world.entity().eid).toBeGreaterThanOrEqual(
      world.pools.find((pool) => pool.name === "entity")?.min ?? Number.POSITIVE_INFINITY
    );
  });

  describe("networkEntityReuseWaitFrames", () => {
    it("takes effect on the server when it is longer than the history", () => {
      const world = newWorld({ networkEntityReuseWaitFrames: 100 });

      expect(configuredWait(world)).toBe(100);
      expect(framesUntilReuse(world, 110)).toBe(100);
    });

    it("is raised to one frame more than the history when it is shorter", () => {
      const world = newWorld({ networkEntityReuseWaitFrames: 0 });

      expect(configuredWait(world)).toBe(HISTORY_LENGTH + 1);
      expect(framesUntilReuse(world, 80)).toBe(65);
    });

    it("is honored down to the history when the history is short", () => {
      const world = newWorld({ historyFrames: 4, networkEntityReuseWaitFrames: 8 });

      expect(configuredWait(world)).toBe(8);
      expect(framesUntilReuse(world, 12)).toBe(8);
    });

    it("is raised to one frame more than a longer history", () => {
      const world = newWorld({ historyFrames: 40, networkEntityReuseWaitFrames: 8 });

      expect(configuredWait(world)).toBe(41);
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects %s instead of silently using the history's",
      (value) => {
        expect(() => newWorld({ networkEntityReuseWaitFrames: value })).toThrow(
          "networkEntityReuseWaitFrames must be a non-negative integer"
        );
      }
    );
  });

  it("still rejects a history shorter than two frames", () => {
    expect(() => newWorld({ historyFrames: 1 })).toThrow("historyFrames must be an integer");
  });
});
