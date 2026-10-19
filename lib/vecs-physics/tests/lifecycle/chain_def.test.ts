// Chain → b2ChainDef mapping: open-chain ghost vertices and the chain material.
//
// Open chains keep the Box2D 3.1 meaning across the Box2D 3.2 update: the first and last points
// are ghost vertices, so N points make N - 3 segments. A Material on the chain entity reaches every
// generated segment.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { getPhysicsEngine } from "../../src/adapter/engine.js";
import { Body, BodyType, Chain, Material, PhysicsModule, Position } from "../../src/index.js";

const STEP_MS = 1000 / 60;

function makeChain(chain: Partial<Chain>, material?: Partial<Material>) {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: -10 } });
  const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
  const entity = world.entity().childOf(ground).set(Chain, chain);
  if (material) {
    entity.set(Material, material);
  }
  world.progress(STEP_MS, STEP_MS);
  const engine = getPhysicsEngine(world);
  const chainId = (entity.get(Chain) as Chain)._chainId;
  return { world, engine, chainId };
}

describe("Chain def", () => {
  it("an open chain treats its first and last points as ghosts", () => {
    const { engine, chainId } = makeChain({
      points: [
        { x: -6, y: 0 },
        { x: -4, y: 0 },
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 6, y: 0 },
      ],
      loop: false,
    });
    expect(chainId).toBeDefined();
    expect(engine.box2d.b2Chain_IsValid(chainId!)).toBe(true);
    expect(engine.box2d.b2Chain_GetSegmentCount(chainId!)).toBe(2);
  });

  it("a loop chain makes one segment per point", () => {
    const { engine, chainId } = makeChain({
      points: [
        { x: 5, y: 0 },
        { x: -5, y: 0 },
        { x: -5, y: -2 },
        { x: 5, y: -2 },
      ],
      loop: true,
    });
    expect(engine.box2d.b2Chain_GetSegmentCount(chainId!)).toBe(4);
  });

  it("applies the entity's Material to every segment", () => {
    const { engine, chainId } = makeChain(
      {
        points: [
          { x: -6, y: 0 },
          { x: -4, y: 0 },
          { x: 4, y: 0 },
          { x: 6, y: 0 },
        ],
        loop: false,
      },
      { friction: 0.15, restitution: 0.4 }
    );
    const box2d = engine.box2d;
    const segments = box2d.b2Chain_GetSegments(chainId!, 4) as Array<
      ReturnType<typeof box2d.b2CreateCircleShape>
    >;
    expect(segments.length).toBe(1);
    expect(box2d.b2Shape_GetFriction(segments[0]!)).toBeCloseTo(0.15, 5);
    expect(box2d.b2Shape_GetRestitution(segments[0]!)).toBeCloseTo(0.4, 5);
  });
});
