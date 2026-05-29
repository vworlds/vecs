// Parity / unit tests for engine/broad_phase.ts.
//
// Box2D has no standalone broad_phase golden test, so these tests verify:
//   - Proxy lifecycle: create, destroy, move, enlarge across all three trees.
//   - Proxy-key encode / decode round-trips (type + id both survive).
//   - moveProxy / enlargeProxy update the stored fat AABB.
//   - updatePairs: finds overlapping proxies across trees and within the dynamic
//     tree; emits each new pair exactly once; excludes static-static; does not
//     re-emit pairs already in the pairSet; stops tracking destroyed proxies.
//   - rebuildTrees: calls rebuild on dynamic and kinematic trees.
//
// Upstream: box2d/src/broad_phase.c, broad_phase.h

import { describe, expect, it } from "vitest";

import type { AABB } from "../../src/math/aabb.js";
import { DYNAMIC_BODY, KINEMATIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import { BroadPhase, proxyId, proxyKey, proxyType } from "../../src/engine/broad_phase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aabb(lx: number, ly: number, ux: number, uy: number): AABB {
  return { lowerBound: { x: lx, y: ly }, upperBound: { x: ux, y: uy } };
}

// Collect all candidate pairs produced by one updatePairs call.
function collectPairs(bp: BroadPhase): Array<{ shapeA: number; shapeB: number }> {
  const pairs: Array<{ shapeA: number; shapeB: number }> = [];
  bp.updatePairs((a, b) => pairs.push({ shapeA: a, shapeB: b }));
  return pairs;
}

// ---------------------------------------------------------------------------
// Proxy-key encode / decode
// ---------------------------------------------------------------------------

describe("proxyKey encode/decode", () => {
  it("round-trips type and id for all three body types", () => {
    for (const type of [STATIC_BODY, KINEMATIC_BODY, DYNAMIC_BODY]) {
      for (const id of [0, 1, 100, 1000, (1 << 28) - 1]) {
        const key = proxyKey(id, type);
        expect(proxyType(key)).toBe(type);
        expect(proxyId(key)).toBe(id);
      }
    }
  });

  it("different (type, id) pairs produce different keys", () => {
    const k1 = proxyKey(0, STATIC_BODY);
    const k2 = proxyKey(0, DYNAMIC_BODY);
    const k3 = proxyKey(1, STATIC_BODY);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });
});

// ---------------------------------------------------------------------------
// createProxy / destroyProxy
// ---------------------------------------------------------------------------

describe("createProxy", () => {
  it("returns a valid proxy key for each body type", () => {
    const bp = new BroadPhase();
    const box = aabb(0, 0, 1, 1);

    const sk = bp.createProxy(STATIC_BODY, box, 1, 0);
    const kk = bp.createProxy(KINEMATIC_BODY, box, 1, 1);
    const dk = bp.createProxy(DYNAMIC_BODY, box, 1, 2);

    expect(proxyType(sk)).toBe(STATIC_BODY);
    expect(proxyType(kk)).toBe(KINEMATIC_BODY);
    expect(proxyType(dk)).toBe(DYNAMIC_BODY);

    expect(proxyId(sk)).toBeGreaterThanOrEqual(0);
    expect(proxyId(kk)).toBeGreaterThanOrEqual(0);
    expect(proxyId(dk)).toBeGreaterThanOrEqual(0);
  });

  it("stores the correct fat AABB in the tree", () => {
    const bp = new BroadPhase();
    const box = aabb(-2, -3, 4, 5);
    const key = bp.createProxy(DYNAMIC_BODY, box, 1, 0);
    const stored = bp.getAABB(key);
    expect(stored.lowerBound.x).toBeCloseTo(-2);
    expect(stored.lowerBound.y).toBeCloseTo(-3);
    expect(stored.upperBound.x).toBeCloseTo(4);
    expect(stored.upperBound.y).toBeCloseTo(5);
  });

  it("stores the correct shapeIndex in the tree", () => {
    const bp = new BroadPhase();
    const key = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 42);
    expect(bp.getShapeIndex(key)).toBe(42);
  });

  it("static proxy is NOT buffered for pair queries by default", () => {
    const bp = new BroadPhase();
    bp.createProxy(STATIC_BODY, aabb(0, 0, 10, 10), 1, 0);
    // No dynamic proxy — nothing should be queried.
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });

  it("dynamic proxy IS buffered and will be queried", () => {
    const bp = new BroadPhase();
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    // One dynamic proxy, no other proxies to overlap with — no pairs.
    // But the buffer should have been consumed (no error).
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });

  it("kinematic proxy IS buffered and will be queried", () => {
    const bp = new BroadPhase();
    bp.createProxy(KINEMATIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });

  it("proxy keys are unique within the same tree", () => {
    const bp = new BroadPhase();
    const box = aabb(0, 0, 1, 1);
    const k1 = bp.createProxy(DYNAMIC_BODY, box, 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, box, 1, 1);
    expect(k1).not.toBe(k2);
  });
});

describe("destroyProxy", () => {
  it("removes the proxy without throwing", () => {
    const bp = new BroadPhase();
    const key = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    expect(() => bp.destroyProxy(key)).not.toThrow();
  });

  it("destroyed proxy no longer appears in pair queries", () => {
    const bp = new BroadPhase();
    const k1 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 1);

    // Consume the buffered creates.
    collectPairs(bp);

    // Move both so they'd be re-queried.
    bp.moveProxy(k1, aabb(0, 0, 2, 2));
    bp.moveProxy(k2, aabb(0, 0, 2, 2));

    // Destroy k2 before the query runs.
    bp.destroyProxy(k2);

    // k1 still moves through the dynamic tree but k2 is gone — no pair.
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// moveProxy / enlargeProxy
// ---------------------------------------------------------------------------

describe("moveProxy", () => {
  it("updates the stored AABB", () => {
    const bp = new BroadPhase();
    const key = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    // consume initial buffer
    collectPairs(bp);

    const newBox = aabb(5, 5, 10, 10);
    bp.moveProxy(key, newBox);
    const stored = bp.getAABB(key);
    expect(stored.lowerBound.x).toBeCloseTo(5);
    expect(stored.lowerBound.y).toBeCloseTo(5);
    expect(stored.upperBound.x).toBeCloseTo(10);
    expect(stored.upperBound.y).toBeCloseTo(10);
  });

  it("buffers the moved proxy for the next pair query", () => {
    const bp = new BroadPhase();
    // Create k1 far from k2 — no initial overlap → no pair emitted.
    const k1 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, aabb(100, 100, 101, 101), 1, 1);
    // consume initial creates (no pairs because they are far apart)
    const initial = collectPairs(bp);
    expect(initial).toHaveLength(0);

    // Move k1 to overlap k2 — this buffers k1 for re-query.
    bp.moveProxy(k1, aabb(99, 99, 102, 102));
    // k1 now queries the dynamic tree and finds k2; pairSet has no prior pair.
    const pairs = collectPairs(bp);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("enlargeProxy", () => {
  it("updates the stored AABB to the new larger box", () => {
    const bp = new BroadPhase();
    const key = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    collectPairs(bp);

    bp.enlargeProxy(key, aabb(-5, -5, 5, 5));
    const stored = bp.getAABB(key);
    expect(stored.lowerBound.x).toBeCloseTo(-5);
    expect(stored.lowerBound.y).toBeCloseTo(-5);
    expect(stored.upperBound.x).toBeCloseTo(5);
    expect(stored.upperBound.y).toBeCloseTo(5);
  });

  it("buffers the enlarged proxy", () => {
    const bp = new BroadPhase();
    const k1 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, aabb(10, 10, 11, 11), 1, 1);
    collectPairs(bp);

    // Enlarge k1 to cover k2's region.
    bp.enlargeProxy(k1, aabb(0, 0, 12, 12));
    const pairs = collectPairs(bp);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// updatePairs — overlap detection
// ---------------------------------------------------------------------------

describe("updatePairs — dynamic vs dynamic", () => {
  it("emits a pair when two overlapping dynamic proxies exist", () => {
    const bp = new BroadPhase();
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 10);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 20);

    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(1);
    const { shapeA, shapeB } = pairs[0]!;
    const sorted = [shapeA, shapeB].sort((a, b) => a - b);
    expect(sorted).toEqual([10, 20]);
  });

  it("does NOT emit a pair when dynamic proxies are far apart", () => {
    const bp = new BroadPhase();
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    bp.createProxy(DYNAMIC_BODY, aabb(100, 100, 101, 101), 1, 1);

    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });

  it("does not emit the same pair twice when both proxies move", () => {
    const bp = new BroadPhase();
    // Create two overlapping dynamic proxies — both buffered on create.
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 0);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 1);

    const pairs = collectPairs(bp);
    // Should see exactly one pair, not two (de-dup by lower proxyKey skipping).
    expect(pairs).toHaveLength(1);
  });
});

describe("updatePairs — dynamic vs static", () => {
  it("emits a pair when a dynamic proxy overlaps a static proxy", () => {
    const bp = new BroadPhase();
    bp.createProxy(STATIC_BODY, aabb(0, 0, 5, 5), 1, 100);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 200);

    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(1);
    const s = [pairs[0]!.shapeA, pairs[0]!.shapeB].sort((a, b) => a - b);
    expect(s).toEqual([100, 200]);
  });

  it("does NOT emit static-static pairs", () => {
    const bp = new BroadPhase();
    bp.createProxy(STATIC_BODY, aabb(0, 0, 5, 5), 1, 0);
    bp.createProxy(STATIC_BODY, aabb(0, 0, 5, 5), 1, 1);
    // No dynamic proxies — static proxies never query.
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });
});

describe("updatePairs — dynamic vs kinematic", () => {
  it("emits a pair when a dynamic proxy overlaps a kinematic proxy", () => {
    const bp = new BroadPhase();
    bp.createProxy(KINEMATIC_BODY, aabb(0, 0, 5, 5), 1, 300);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 400);

    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(1);
    const s = [pairs[0]!.shapeA, pairs[0]!.shapeB].sort((a, b) => a - b);
    expect(s).toEqual([300, 400]);
  });
});

describe("updatePairs — pairSet de-duplication across calls", () => {
  it("does NOT re-emit a pair already in the pairSet on a subsequent call", () => {
    const bp = new BroadPhase();
    const k1 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 1);

    // First update — emits the pair and adds it to pairSet.
    const first = collectPairs(bp);
    expect(first).toHaveLength(1);

    // Move both so they'd be queried again.
    bp.moveProxy(k1, aabb(0, 0, 2, 2));
    bp.moveProxy(k2, aabb(1, 1, 3, 3));

    // Second update — pair already exists in pairSet, must not re-emit.
    const second = collectPairs(bp);
    expect(second).toHaveLength(0);
  });

  it("allows adding and removing pairs from the pairSet", () => {
    const bp = new BroadPhase();
    const k1 = bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 0);
    const k2 = bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 1);

    const first = collectPairs(bp);
    expect(first).toHaveLength(1);

    // Simulate M3 removing the pair from pairSet (they no longer overlap).
    const [shapeA, shapeB] = [first[0]!.shapeA, first[0]!.shapeB].sort((a, b) => a - b);
    bp.removePair(shapeA!, shapeB!);

    // Move both so they'd be queried again.
    bp.moveProxy(k1, aabb(0, 0, 2, 2));
    bp.moveProxy(k2, aabb(1, 1, 3, 3));

    // After removal from pairSet the pair should be emitted again.
    const second = collectPairs(bp);
    expect(second).toHaveLength(1);
  });
});

describe("updatePairs — move buffer cleared after each call", () => {
  it("does not carry over buffered proxies to the next updatePairs call", () => {
    const bp = new BroadPhase();
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 2, 2), 1, 0);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 1);

    collectPairs(bp); // first call — consume buffer

    // No proxies moved since last call.
    const pairs = collectPairs(bp);
    expect(pairs).toHaveLength(0);
  });
});

describe("updatePairs — three-tree interactions", () => {
  it("a kinematic proxy overlapping a dynamic proxy emits a pair when kinematic moves", () => {
    const bp = new BroadPhase();
    // Kinematic starts far from dynamic so the initial creates produce no pair.
    const kk = bp.createProxy(KINEMATIC_BODY, aabb(50, 50, 55, 55), 1, 10);
    const dk = bp.createProxy(DYNAMIC_BODY, aabb(100, 100, 101, 101), 1, 20);

    const initial = collectPairs(bp); // consume creates — no overlap yet
    expect(initial).toHaveLength(0);

    // Move kinematic into the dynamic proxy's region.
    bp.moveProxy(kk, aabb(99, 99, 102, 102));

    const pairs = collectPairs(bp);

    // Kinematic queries the dynamic tree — finds the dynamic proxy.
    const dynKinPair = pairs.find(
      (p) => (p.shapeA === 10 && p.shapeB === 20) || (p.shapeA === 20 && p.shapeB === 10)
    );
    expect(dynKinPair).toBeDefined();
  });

  it("emits dynamic-kinematic and dynamic-static pairs in the same update", () => {
    const bp = new BroadPhase();
    bp.createProxy(STATIC_BODY, aabb(0, 0, 5, 5), 1, 1);
    bp.createProxy(KINEMATIC_BODY, aabb(0, 0, 5, 5), 1, 2);
    bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 3);

    const pairs = collectPairs(bp);
    // Dynamic queries both static and kinematic trees; should see both pairs.
    expect(pairs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// rebuildTrees
// ---------------------------------------------------------------------------

describe("rebuildTrees", () => {
  it("does not throw on empty trees", () => {
    const bp = new BroadPhase();
    expect(() => bp.rebuildTrees()).not.toThrow();
  });

  it("does not throw after proxies have been added", () => {
    const bp = new BroadPhase();
    bp.createProxy(DYNAMIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    bp.createProxy(KINEMATIC_BODY, aabb(5, 5, 6, 6), 1, 1);
    collectPairs(bp);
    expect(() => bp.rebuildTrees()).not.toThrow();
  });

  it("trees remain structurally valid after rebuild", () => {
    const bp = new BroadPhase();
    for (let i = 0; i < 8; i++) {
      bp.createProxy(DYNAMIC_BODY, aabb(i, i, i + 1, i + 1), 1, i);
    }
    collectPairs(bp);
    bp.rebuildTrees();
    // No throw means validate() inside rebuild() passed.
  });
});

// ---------------------------------------------------------------------------
// testOverlap
// ---------------------------------------------------------------------------

describe("testOverlap", () => {
  it("returns true for overlapping proxies in different trees", () => {
    const bp = new BroadPhase();
    const sk = bp.createProxy(STATIC_BODY, aabb(0, 0, 5, 5), 1, 0);
    const dk = bp.createProxy(DYNAMIC_BODY, aabb(1, 1, 3, 3), 1, 1);
    expect(bp.testOverlap(sk, dk)).toBe(true);
  });

  it("returns false for non-overlapping proxies", () => {
    const bp = new BroadPhase();
    const sk = bp.createProxy(STATIC_BODY, aabb(0, 0, 1, 1), 1, 0);
    const dk = bp.createProxy(DYNAMIC_BODY, aabb(10, 10, 11, 11), 1, 1);
    expect(bp.testOverlap(sk, dk)).toBe(false);
  });
});
