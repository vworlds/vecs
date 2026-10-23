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
    const { world, engine, chainId } = makeChain({
      points: [
        { x: -6, y: 2 },
        { x: -4, y: 0 },
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 6, y: -3 },
      ],
      loop: false,
    });
    expect(chainId).toBeDefined();
    expect(engine.box2d.b2Chain_IsValid(chainId!)).toBe(true);
    expect(engine.box2d.b2Chain_GetSegmentCount(chainId!)).toBe(2);
    const segments = engine.box2d.b2Chain_GetSegments(chainId!, 2) as Array<
      ReturnType<typeof engine.box2d.b2CreateCircleShape>
    >;
    const first = engine.box2d.b2Shape_GetChainSegment(segments[0]!);
    const last = engine.box2d.b2Shape_GetChainSegment(segments[1]!);
    try {
      expect({ x: first.ghost1.x, y: first.ghost1.y }).toEqual({ x: -6, y: 2 });
      expect({ x: last.ghost2.x, y: last.ghost2.y }).toEqual({ x: 6, y: -3 });
    } finally {
      first.delete();
      last.delete();
      world.dispose();
    }
  });

  it("a loop chain makes one segment per point", () => {
    const { world, engine, chainId } = makeChain({
      points: [
        { x: 5, y: 0 },
        { x: -5, y: 0 },
        { x: -5, y: -2 },
        { x: 5, y: -2 },
      ],
      loop: true,
    });
    expect(engine.box2d.b2Chain_GetSegmentCount(chainId!)).toBe(4);
    world.dispose();
  });

  it("applies the entity's Material to every segment", () => {
    const { world, engine, chainId } = makeChain(
      {
        points: [
          { x: -6, y: 0 },
          { x: -4, y: 0 },
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 6, y: 0 },
        ],
        loop: false,
      },
      {
        friction: 0.15,
        restitution: 0.4,
        rollingResistance: 0.2,
        tangentSpeed: 1.5,
        userMaterialId: 42,
      }
    );
    const box2d = engine.box2d;
    const segments = box2d.b2Chain_GetSegments(chainId!, 4) as Array<
      ReturnType<typeof box2d.b2CreateCircleShape>
    >;
    expect(segments.length).toBe(2);
    for (let i = 0; i < segments.length; i++) {
      expect(box2d.b2Shape_GetFriction(segments[i]!)).toBeCloseTo(0.15, 5);
      expect(box2d.b2Shape_GetRestitution(segments[i]!)).toBeCloseTo(0.4, 5);
      expect(box2d.b2Shape_GetUserMaterial(segments[i]!)).toBe(42n);
      const material = box2d.b2Chain_GetSurfaceMaterial(chainId!, i);
      try {
        expect(material.rollingResistance).toBeCloseTo(0.2, 5);
        expect(material.tangentSpeed).toBeCloseTo(1.5, 5);
      } finally {
        material.delete();
      }
    }
    world.dispose();
  });
});
