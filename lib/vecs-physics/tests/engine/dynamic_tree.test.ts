// Parity tests for engine/dynamic_tree.ts.
// Ported from box2d/test/test_dynamic_tree.c (DynamicTreeTest / all nine subtests).

import { describe, expect, it } from "vitest";

import type { AABB } from "../../src/math/aabb.js";
import type { Vec2 } from "../../src/math/vec2.js";
import {
  DynamicTree,
  type RayCastInput,
  type TreeQueryCallback,
  type TreeRayCastCallback,
} from "../../src/engine/dynamic_tree.js";

// ---------------------------------------------------------------------------
// TreeCreateDestroy
// ---------------------------------------------------------------------------

describe("TreeCreateDestroy", () => {
  it("nodeCount > 0 and proxyCount == 1 after creating a proxy, then zeroes after destroy", () => {
    const a: AABB = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 2, y: 2 } };
    const tree = new DynamicTree(16);
    tree.createProxy(a, 1, 0);

    expect(tree.nodeCount).toBeGreaterThan(0);
    expect(tree.proxyCount).toBe(1);

    tree.destroy();

    expect(tree.nodeCount).toBe(0);
    expect(tree.proxyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TreeRayCastTest — 13 sub-cases
// ---------------------------------------------------------------------------

describe("TreeRayCastTest", () => {
  /** Callback that records the proxyId of the first leaf it hits and stops. */
  function makeHitCallback(): { cb: TreeRayCastCallback; proxyHit: () => number } {
    let hit = -1;
    const cb: TreeRayCastCallback = (_input, proxyId, _userData) => {
      hit = proxyId;
      return 0; // terminate immediately
    };
    return { cb, proxyHit: () => hit };
  }

  function aabbAt(lx: number, ly: number, ux: number, uy: number): AABB {
    return { lowerBound: { x: lx, y: ly }, upperBound: { x: ux, y: uy } };
  }

  function rayCast(tree: DynamicTree, p1: Vec2, p2: Vec2): { proxyHit: number } {
    const input: RayCastInput = {
      origin: p1,
      translation: { x: p2.x - p1.x, y: p2.y - p1.y },
      maxFraction: 1,
    };
    const { cb, proxyHit } = makeHitCallback();
    tree.rayCast(input, 1, cb);
    return { proxyHit: proxyHit() };
  }

  it("hits AABB from left side", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -3, y: 0 }, { x: 3, y: 0 });
    expect(proxyHit).toBe(proxyId);
  });

  it("hits AABB from right side", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 3, y: 0 }, { x: -3, y: 0 });
    expect(proxyHit).toBe(proxyId);
  });

  it("hits AABB from bottom", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 0, y: -3 }, { x: 0, y: 3 });
    expect(proxyHit).toBe(proxyId);
  });

  it("hits AABB from top", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 0, y: 3 }, { x: 0, y: -3 });
    expect(proxyHit).toBe(proxyId);
  });

  it("misses AABB — parallel to x-axis, outside", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -3, y: 2 }, { x: 3, y: 2 });
    expect(proxyHit).toBe(-1);
  });

  it("misses AABB — parallel to y-axis, outside", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 2, y: -3 }, { x: 2, y: 3 });
    expect(proxyHit).toBe(-1);
  });

  it("hits AABB — ray starts inside", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(proxyHit).toBe(proxyId);
  });

  it("hits AABB corner — diagonal ray", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -2, y: -2 }, { x: 2, y: 2 });
    expect(proxyHit).toBe(proxyId);
  });

  it("misses AABB — parallel to edge but outside (y=1.5)", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -2, y: 1.5 }, { x: 2, y: 1.5 });
    expect(proxyHit).toBe(-1);
  });

  it("hits AABB — ray exactly on boundary (y=1.0)", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -2, y: 1 }, { x: 2, y: 1 });
    expect(proxyHit).toBe(proxyId);
  });

  it("misses AABB — very short ray that does not reach it", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -3, y: 0 }, { x: -2.5, y: 0 });
    expect(proxyHit).toBe(-1);
  });

  it("hits AABB — zero-length ray inside", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(proxyHit).toBe(proxyId);
  });

  it("hits AABB — ray ends exactly at boundary (t=1.0)", () => {
    const tree = new DynamicTree(16);
    const a = aabbAt(-1, -1, 1, 1);
    const proxyId = tree.createProxy(a, 1, 0);
    const { proxyHit } = rayCast(tree, { x: -2, y: 0 }, { x: -1, y: 0 });
    expect(proxyHit).toBe(proxyId);
  });
});

// ---------------------------------------------------------------------------
// TreeMultipleProxiesTest
// ---------------------------------------------------------------------------

describe("TreeMultipleProxiesTest", () => {
  it("stores userData and categoryBits correctly for three proxies", () => {
    const tree = new DynamicTree(16);

    const a1: AABB = { lowerBound: { x: -5, y: -1 }, upperBound: { x: -3, y: 1 } };
    const a2: AABB = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } };
    const a3: AABB = { lowerBound: { x: 3, y: -1 }, upperBound: { x: 5, y: 1 } };

    const id1 = tree.createProxy(a1, 0x1, 42);
    const id2 = tree.createProxy(a2, 0x2, 43);
    const id3 = tree.createProxy(a3, 0x4, 44);

    expect(tree.getProxyCount()).toBe(3);

    expect(tree.getUserData(id1)).toBe(42);
    expect(tree.getUserData(id2)).toBe(43);
    expect(tree.getUserData(id3)).toBe(44);

    expect(tree.getCategoryBits(id1)).toBe(0x1);
    expect(tree.getCategoryBits(id2)).toBe(0x2);
    expect(tree.getCategoryBits(id3)).toBe(0x4);
  });
});

// ---------------------------------------------------------------------------
// TreeQueryTest
// ---------------------------------------------------------------------------

describe("TreeQueryTest", () => {
  it("query finds the overlapping proxy and at least one leaf visit", () => {
    const tree = new DynamicTree(16);

    const a1: AABB = { lowerBound: { x: -5, y: -1 }, upperBound: { x: -3, y: 1 } };
    const a2: AABB = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } };
    const a3: AABB = { lowerBound: { x: 3, y: -1 }, upperBound: { x: 5, y: 1 } };

    tree.createProxy(a1, 0xff, 0);
    const id2 = tree.createProxy(a2, 0xff, 0);
    tree.createProxy(a3, 0xff, 0);

    const queryA: AABB = { lowerBound: { x: -2, y: -2 }, upperBound: { x: 2, y: 2 } };

    const foundFlags: Record<number, number> = {};
    const collectCb: TreeQueryCallback = (proxyId, _userData) => {
      foundFlags[proxyId] = 1;
      return true;
    };

    const stats = tree.query(queryA, 0xffffffff, collectCb);

    expect(foundFlags[id2]).toBe(1);
    expect(stats.leafVisits).toBeGreaterThanOrEqual(1);
  });

  it("queryAll finds at least one proxy and at least one leaf visit", () => {
    const tree = new DynamicTree(16);

    const a1: AABB = { lowerBound: { x: -5, y: -1 }, upperBound: { x: -3, y: 1 } };
    const a2: AABB = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } };
    const a3: AABB = { lowerBound: { x: 3, y: -1 }, upperBound: { x: 5, y: 1 } };

    tree.createProxy(a1, 0xff, 0);
    tree.createProxy(a2, 0xff, 0);
    tree.createProxy(a3, 0xff, 0);

    const queryA: AABB = { lowerBound: { x: -2, y: -2 }, upperBound: { x: 2, y: 2 } };

    const list: number[] = [];
    const listCb: TreeQueryCallback = (proxyId, _userData) => {
      list.push(proxyId);
      return true;
    };

    const allStats = tree.queryAll(queryA, listCb);

    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(allStats.leafVisits).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TreeMoveAndEnlargeTest
// ---------------------------------------------------------------------------

describe("TreeMoveAndEnlargeTest", () => {
  it("moveProxy updates AABB; enlargeProxy expands it", () => {
    const tree = new DynamicTree(16);

    const a: AABB = { lowerBound: { x: 0, y: 0 }, upperBound: { x: 1, y: 1 } };
    const id = tree.createProxy(a, 0x1, 100);

    const moved: AABB = { lowerBound: { x: 10, y: 10 }, upperBound: { x: 11, y: 11 } };
    tree.moveProxy(id, moved);

    const got = tree.getAABB(id);
    expect(got.lowerBound.x).toBe(moved.lowerBound.x);
    expect(got.lowerBound.y).toBe(moved.lowerBound.y);
    expect(got.upperBound.x).toBe(moved.upperBound.x);
    expect(got.upperBound.y).toBe(moved.upperBound.y);

    const enlarge: AABB = { lowerBound: { x: 9.5, y: 9.5 }, upperBound: { x: 11.5, y: 11.5 } };
    tree.enlargeProxy(id, enlarge);

    const got2 = tree.getAABB(id);
    expect(got2.lowerBound.x).toBeLessThanOrEqual(enlarge.lowerBound.x + 1e-6);
    expect(got2.upperBound.x).toBeGreaterThanOrEqual(enlarge.upperBound.x - 1e-6);
  });
});

// ---------------------------------------------------------------------------
// TreeRebuildAndValidateTest
// ---------------------------------------------------------------------------

describe("TreeRebuildAndValidateTest", () => {
  it("rebuild returns a non-negative leaf count and a positive byte count and height", () => {
    const tree = new DynamicTree(16);

    for (let i = 0; i < 12; i++) {
      const x = i * 2;
      const a: AABB = {
        lowerBound: { x: x - 0.5, y: -0.5 },
        upperBound: { x: x + 0.5, y: 0.5 },
      };
      tree.createProxy(a, 0xff, i);
    }

    const sorted = tree.rebuild(true);

    expect(sorted).toBeGreaterThanOrEqual(0);
    expect(tree.getByteCount()).toBeGreaterThan(0);
    expect(tree.getHeight()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TreeRowHeightTest — 200 proxies in a row, height < 2 * log2(count)
// ---------------------------------------------------------------------------

describe("TreeRowHeightTest", () => {
  it("200 proxies in a row produce a tree height below 2*log2(200)", () => {
    const tree = new DynamicTree(16);
    const columnCount = 200;

    for (let i = 0; i < columnCount; i++) {
      const x = i;
      const a: AABB = { lowerBound: { x, y: 0 }, upperBound: { x: x + 1, y: 1 } };
      tree.createProxy(a, 1, i);
    }

    const minHeight = Math.log2(columnCount);
    expect(tree.getHeight()).toBeLessThan(2 * minHeight);
  });
});

// ---------------------------------------------------------------------------
// TreeGridHeightTest — 20x20 grid, height < 2 * log2(count)
// ---------------------------------------------------------------------------

describe("TreeGridHeightTest", () => {
  it("20x20 grid produces a tree height below 2*log2(400)", () => {
    const tree = new DynamicTree(16);
    const columnCount = 20;
    const rowCount = 20;

    for (let i = 0; i < columnCount; i++) {
      const x = i;
      for (let j = 0; j < rowCount; j++) {
        const y = j;
        const a: AABB = { lowerBound: { x, y }, upperBound: { x: x + 1, y: y + 1 } };
        tree.createProxy(a, 1, i);
      }
    }

    const minHeight = Math.log2(rowCount * columnCount);
    expect(tree.getHeight()).toBeLessThan(2 * minHeight);
  });
});

// ---------------------------------------------------------------------------
// TreeGridMovementTest — 20x20 grid, move all, rebuild, check heights
// ---------------------------------------------------------------------------

describe("TreeGridMovementTest", () => {
  const GRID_COUNT = 20;

  it("moving all proxies keeps height < 3*log2(n); rebuild brings it below 2*log2(n)", () => {
    const tree = new DynamicTree(16);
    const proxyIds: number[] = [];

    for (let i = 0; i < GRID_COUNT; i++) {
      const x = i;
      for (let j = 0; j < GRID_COUNT; j++) {
        const y = j;
        const a: AABB = { lowerBound: { x, y }, upperBound: { x: x + 1, y: y + 1 } };
        proxyIds.push(tree.createProxy(a, 1, i));
      }
    }

    expect(proxyIds.length).toBe(GRID_COUNT * GRID_COUNT);

    const minHeight = Math.log2(GRID_COUNT * GRID_COUNT);

    const height1 = tree.getHeight();
    expect(height1).toBeLessThan(2 * minHeight);

    const offset: Vec2 = { x: 10, y: 20 };
    let index = 0;
    for (let i = 0; i < GRID_COUNT; i++) {
      for (let j = 0; j < GRID_COUNT; j++) {
        const a = tree.getAABB(proxyIds[index]!);
        const moved: AABB = {
          lowerBound: { x: a.lowerBound.x + offset.x, y: a.lowerBound.y + offset.y },
          upperBound: { x: a.upperBound.x + offset.x, y: a.upperBound.y + offset.y },
        };
        tree.moveProxy(proxyIds[index]!, moved);
        index++;
      }
    }

    const height2 = tree.getHeight();
    expect(height2).toBeLessThan(3 * minHeight);

    tree.rebuild(true);

    const height3 = tree.getHeight();
    expect(height3).toBeLessThan(2 * minHeight);
  });
});
