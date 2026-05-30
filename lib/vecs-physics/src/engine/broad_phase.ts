// Broad-phase collision detection: three BVH trees (one per body type) plus
// move-buffering and pair-set de-duplication.
//
// Ported from box2d/src/broad_phase.c + broad_phase.h.
//
// Key design decisions vs the C source ("port the model, not the C
// representation" — PLAN.md → _Box2D Porting Strategy_):
//   - Proxy key: plain `number`, same bit-packing as box2d (lower 2 bits =
//     body type, upper 30 bits = proxy id within that tree).
//   - movedProxies bit-sets → a plain JS `Set<number>` of proxy keys (the
//     move buffer). `moveArray` order is preserved for determinism.
//   - pairSet (b2HashSet of uint64 keys) → a JS `Set<number>` of encoded pair
//     keys. A pair key encodes (minShapeIndex << 22 | maxShapeIndex) as a safe
//     integer for shape indices < 2^22 (4M shapes per world — ample).
//   - Parallel multi-task machinery removed: single-threaded JS. All work runs
//     inline in updatePairs.
//   - Category-bits mask: B2_DEFAULT_MASK_BITS = 0xffffffff passed to every
//     tree query (per box2d's b2FindPairsTask), so groupIndex filtering still
//     works from the category/mask propagation inside DynamicTree.

import { DYNAMIC_BODY, KINEMATIC_BODY, STATIC_BODY } from "./body.js";
import { DynamicTree } from "./dynamic_tree.js";
import type { AABB } from "../math/aabb.js";

// ---------------------------------------------------------------------------
// Proxy-key helpers (B2_PROXY_KEY / B2_PROXY_TYPE / B2_PROXY_ID)
// ---------------------------------------------------------------------------

/** Encode a (proxyId, bodyType) pair into a compact proxy key.
 *  Mirrors `B2_PROXY_KEY(ID, TYPE) ((ID) << 2 | (TYPE))`.
 *  Body type occupies the lower 2 bits; proxy id the upper 30. */
export function proxyKey(id: number, type: number): number {
  return (id << 2) | type;
}

/** Extract the body-type index (0/1/2) from a proxy key.
 *  Mirrors `B2_PROXY_TYPE(KEY) ((KEY) & 3)`. */
export function proxyType(key: number): number {
  return key & 3;
}

/** Extract the within-tree proxy id from a proxy key.
 *  Mirrors `B2_PROXY_ID(KEY) ((KEY) >> 2)`. */
export function proxyId(key: number): number {
  return key >> 2;
}

// ---------------------------------------------------------------------------
// Pair-key helpers (B2_SHAPE_PAIR_KEY)
// ---------------------------------------------------------------------------

// Box2d encodes shape pair keys as uint64 (shapeIdA << 32 | shapeIdB) with
// the lower index in the high word so pairs are canonical. We need safe JS
// integers. Shape indices are int32 in box2d but realistically < 2^22 per
// world. Encoding: hi22 = minIndex, lo22 = maxIndex → fits in 44 bits, well
// within Number.MAX_SAFE_INTEGER (53 bits). The pair is always stored with
// the smaller index first, mirroring box2d's canonical ordering.
const PAIR_BITS = 22; // max 4 M shapes per world

function pairKey(a: number, b: number): number {
  // Canonical order: smaller index in high bits.
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * (1 << PAIR_BITS) + hi;
}

// ---------------------------------------------------------------------------
// BroadPhase
// ---------------------------------------------------------------------------

/** Candidate-pair callback emitted by {@link BroadPhase.updatePairs}. */
export type PairCallback = (shapeIndexA: number, shapeIndexB: number) => void;

/**
 * Broad-phase collision detection wrapping three {@link DynamicTree}s indexed
 * by numeric body type (STATIC=0, KINEMATIC=1, DYNAMIC=2).
 *
 * Mirrors `b2BroadPhase` from box2d/src/broad_phase.c.
 *
 * Public API (VP-11 inserts proxies; M3 consumes pairs):
 *   - {@link createProxy} / {@link destroyProxy}
 *   - {@link moveProxy} / {@link enlargeProxy}
 *   - {@link updatePairs} — emit candidate pairs via callback
 *   - {@link removePair} — M3 signals a contact was destroyed
 *   - {@link rebuildTrees}
 *   - {@link testOverlap} / {@link getAABB} / {@link getShapeIndex}
 */
export class BroadPhase {
  // Three trees: [STATIC_BODY, KINEMATIC_BODY, DYNAMIC_BODY].
  // Mirrors b2BroadPhase::trees[b2_bodyTypeCount].
  private readonly _trees: [DynamicTree, DynamicTree, DynamicTree];

  // Move buffer: proxy keys waiting to be queried in the next updatePairs.
  // Mirrors b2BroadPhase::moveArray + movedProxies (bit-set de-dup).
  // We use a Set for O(1) membership and an Array for deterministic order.
  private readonly _movedSet = new Set<number>();
  private readonly _moveArray: number[] = [];

  // Tracks shape pairs that have an active contact (b2BroadPhase::pairSet).
  // Key = pairKey(shapeIndexA, shapeIndexB).
  private readonly _pairSet = new Set<number>();

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  constructor() {
    this._trees = [
      new DynamicTree(16), // STATIC_BODY
      new DynamicTree(16), // KINEMATIC_BODY
      new DynamicTree(16), // DYNAMIC_BODY
    ];
  }

  // -------------------------------------------------------------------------
  // Proxy lifecycle (b2BroadPhase_CreateProxy / DestroyProxy)
  // -------------------------------------------------------------------------

  /**
   * Create a leaf proxy in the tree for `bodyType` and return the proxy key.
   * Non-static proxies are immediately buffered for pair queries.
   * Mirrors `b2BroadPhase_CreateProxy`.
   *
   * @param bodyType  STATIC_BODY | KINEMATIC_BODY | DYNAMIC_BODY
   * @param fatAABB   Fat AABB (caller must apply motion-predict inflation)
   * @param categoryBits  Collision category bits (from the shape filter)
   * @param shapeIndex    Engine shape index stored as userData in the tree leaf
   * @param forcePairCreation  Buffer the proxy even when it is static, so its
   *   overlaps are evaluated for contacts immediately. Box2D's default
   *   `b2ShapeDef` sets `invokeContactCreation = true`, which `b2CreateShapeProxy`
   *   passes here (shape.c:176); the enable / type-change proxy recreation paths
   *   also force it (shape.c:1307). Defaults to `false` (the plain VP-10 query
   *   semantics) for callers that do not create a contactable shape.
   * @returns Encoded proxy key (store on InternalShape.proxyKey)
   */
  createProxy(
    bodyType: number,
    fatAABB: AABB,
    categoryBits: number,
    shapeIndex: number,
    forcePairCreation = false
  ): number {
    const id = this._trees[bodyType]!.createProxy(fatAABB, categoryBits, shapeIndex);
    const key = proxyKey(id, bodyType);

    // Buffer the new proxy for the next pair query. Non-static proxies are always
    // buffered; a static proxy only when forcePairCreation is set. Mirrors
    // b2BroadPhase_CreateProxy (broad_phase.c:104-112): `if ( proxyType !=
    // b2_staticBody || forcePairCreation ) b2BufferMove(...)`. Without the force
    // path a static shape added under an already-settled, non-moving shape would
    // not form a contact until some other proxy happened to move. Static bodies
    // never move, so a forced static proxy is queried exactly once.
    if (bodyType !== STATIC_BODY || forcePairCreation) {
      this._bufferMove(key);
    }

    return key;
  }

  /**
   * Remove a proxy from its tree and clear any pending move buffer entry.
   * Mirrors `b2BroadPhase_DestroyProxy`.
   */
  destroyProxy(key: number): void {
    this._unBufferMove(key);
    const type = proxyType(key);
    const id = proxyId(key);
    this._trees[type]!.destroyProxy(id);
  }

  // -------------------------------------------------------------------------
  // Proxy update (b2BroadPhase_MoveProxy / EnlargeProxy)
  // -------------------------------------------------------------------------

  /**
   * Move a proxy to a new AABB (remove + reinsert in the tree) and buffer it.
   * Mirrors `b2BroadPhase_MoveProxy`.
   */
  moveProxy(key: number, fatAABB: AABB): void {
    const type = proxyType(key);
    const id = proxyId(key);
    this._trees[type]!.moveProxy(id, fatAABB);
    this._bufferMove(key);
  }

  /**
   * Enlarge a proxy's AABB in place and buffer it for re-query.
   * Only for non-static proxies (mirrors box2d's assert).
   * Mirrors `b2BroadPhase_EnlargeProxy`.
   */
  enlargeProxy(key: number, fatAABB: AABB): void {
    const type = proxyType(key);
    const id = proxyId(key);
    this._trees[type]!.enlargeProxy(id, fatAABB);
    this._bufferMove(key);
  }

  // -------------------------------------------------------------------------
  // Pair update (b2UpdateBroadPhasePairs)
  // -------------------------------------------------------------------------

  /**
   * For each buffered moved proxy query the relevant trees, collect candidate
   * pairs, and emit each **new** pair once via `callback`.
   *
   * Pair semantics (mirrors b2BroadPhase + b2PairQueryCallback):
   *   - A dynamic proxy queries: kinematic tree, static tree, dynamic tree.
   *   - A kinematic proxy queries: dynamic tree only.
   *   - A static proxy is never buffered → never queries.
   *   - Self-pair is skipped.
   *   - If both proxies are dynamic and moving, the lower-proxyKey proxy skips
   *     the pair (the higher-key proxy will emit it instead). This de-dupes
   *     within a single update without touching the pairSet.
   *   - A pair already in `_pairSet` is skipped (a contact already exists).
   *
   * `_pairSet` membership means "a contact exists"; it is maintained by the
   * contact layer via {@link addPair} / {@link removePair} (box2d adds the key
   * in `b2CreateContact`). This method does NOT add to `_pairSet` on emit. The
   * shape filtering (same-body / sensor / `b2ShouldShapesCollide`) that box2d's
   * `b2PairQueryCallback` does is likewise deferred to the contact-create
   * callback (the broad phase stays shape-agnostic — it only knows shape
   * indices via tree userData). In-batch de-dup of two moved proxies finding
   * the same target within one call uses a local emitted-key {@link Set}.
   *
   * After emitting pairs the move buffer is cleared (both the set and array).
   * Mirrors `b2UpdateBroadPhasePairs`.
   */
  updatePairs(callback: PairCallback): void {
    const moveCount = this._moveArray.length;
    if (moveCount === 0) {
      return;
    }

    // Collect candidate pairs via per-proxy tree queries.
    // Box2d uses a linked list of b2MovePair per b2MoveResult; we use a flat
    // array (same deterministic order).
    const candidates: Array<{ shapeA: number; shapeB: number }> = [];

    for (let i = 0; i < moveCount; i++) {
      const queryKey = this._moveArray[i]!;
      const queryType = proxyType(queryKey);
      const queryId = proxyId(queryKey);

      const baseTree = this._trees[queryType]!;
      const fatAABB = baseTree.getAABB(queryId);
      const queryShapeIndex = baseTree.getUserData(queryId);

      // b2FindPairsTask: query mask B2_DEFAULT_MASK_BITS = 0xffffffff.
      const maskBits = 0xffffffff;

      const queryOneTree = (treeType: number) => {
        this._trees[treeType]!.query(fatAABB, maskBits, (foundId, foundShapeIndex) => {
          const foundKey = proxyKey(foundId, treeType);

          // Skip self.
          if (foundKey === queryKey) {
            return true;
          }

          // De-duplication (mirrors b2PairQueryCallback):
          // When both proxies are dynamic and the found key is less than the
          // query key, the found proxy may also be moving. If it is, skip the
          // pair here — the found proxy will emit it when it queries.
          if (queryType === DYNAMIC_BODY) {
            if (treeType === DYNAMIC_BODY && foundKey < queryKey) {
              if (this._movedSet.has(foundKey)) {
                return true; // Both moving — other side will emit.
              }
            }
          } else {
            // queryType is KINEMATIC_BODY, or a force-buffered STATIC_BODY
            // proxy (see createProxy's forcePairCreation). Either way the only
            // tree it queries is DYNAMIC_BODY. If the found dynamic proxy is also
            // moving, skip — the dynamic side will emit the pair when it queries
            // this tree (a moving static cannot happen: static proxies never move
            // after their one forced buffer).
            if (this._movedSet.has(foundKey)) {
              return true;
            }
          }

          // Check pairSet — skip if the pair already has an active contact.
          const minShape = queryShapeIndex < foundShapeIndex ? queryShapeIndex : foundShapeIndex;
          const maxShape = queryShapeIndex < foundShapeIndex ? foundShapeIndex : queryShapeIndex;
          const pk = pairKey(minShape, maxShape);
          if (this._pairSet.has(pk)) {
            return true;
          }

          // Canonical ordering (mirrors box2d: lower proxyKey → shapeIdA).
          if (foundKey < queryKey) {
            candidates.push({ shapeA: foundShapeIndex, shapeB: queryShapeIndex });
          } else {
            candidates.push({ shapeA: queryShapeIndex, shapeB: foundShapeIndex });
          }

          return true; // continue query
        });
      };

      // Query trees per body type (b2FindPairsTask logic):
      //   dynamic queries kinematic, static, and dynamic.
      //   kinematic queries dynamic only.
      //   static is never in the move buffer.
      if (queryType === DYNAMIC_BODY) {
        queryOneTree(KINEMATIC_BODY);
        queryOneTree(STATIC_BODY);
      }
      queryOneTree(DYNAMIC_BODY);
    }

    // --- Rebuild dynamic and kinematic trees (b2UpdateTreesTask) ---
    // In box2d this runs in a parallel task; we do it inline.
    this._trees[DYNAMIC_BODY]!.rebuild(false);
    this._trees[KINEMATIC_BODY]!.rebuild(false);

    // --- Emit pairs (single-threaded, deterministic) ---
    // In-batch de-dup uses a LOCAL set (not _pairSet): two moved proxies both
    // finding the same target in one call must emit the candidate only once.
    // _pairSet is NOT touched here — it now means "a contact exists" and is
    // maintained by the contact layer (addPair/removePair). The callback (the
    // contact-create path) does the shape filtering and the _pairSet add.
    const emitted = new Set<number>();
    for (const c of candidates) {
      const pk = pairKey(c.shapeA, c.shapeB);
      if (!emitted.has(pk)) {
        emitted.add(pk);
        callback(c.shapeA, c.shapeB);
      }
    }

    // --- Clear move buffer (b2BroadPhase::moveArray / movedProxies clear) ---
    this._movedSet.clear();
    this._moveArray.length = 0;
  }

  // -------------------------------------------------------------------------
  // All-tree query (VP-21c sensor pass)
  // -------------------------------------------------------------------------

  /**
   * Query all three trees (static, kinematic, dynamic) with the given AABB
   * and maskBits, invoking `callback(proxyId, shapeIndex)` for every candidate.
   *
   * Used by the sensor overlap pass (`engine/sensor.ts`), which must search
   * all body types because a sensor on a static body should still detect a
   * dynamic visitor (and vice-versa). The contact broad-phase only queries
   * selected trees per body type; sensors query everything.
   *
   * Mirrors box2d's sensor.c:191-193:
   *   ```c
   *   b2DynamicTree_Query(trees + 0, queryBounds, maskBits, cb, ctx);
   *   b2DynamicTree_Query(trees + 1, queryBounds, maskBits, cb, ctx);
   *   b2DynamicTree_Query(trees + 2, queryBounds, maskBits, cb, ctx);
   *   ```
   *
   * The `userData` delivered to the callback is the shape index stored in the
   * tree leaf (matching `BroadPhase.getShapeIndex`).
   */
  queryAll(
    aabb: AABB,
    maskBits: number,
    callback: (proxyId: number, shapeIndex: number) => boolean
  ): void {
    for (let t = 0; t < 3; t++) {
      this._trees[t]!.query(aabb, maskBits, callback);
    }
  }

  // -------------------------------------------------------------------------
  // Pair tracking (M3 interface)
  // -------------------------------------------------------------------------

  /**
   * Add a pair to the pair set (called by M3 from the contact-create path so
   * pairSet membership means "a contact exists"). Mirrors `b2AddKey(
   * &broadPhase.pairSet, B2_SHAPE_PAIR_KEY(...) )` in `b2CreateContact`.
   */
  addPair(shapeIndexA: number, shapeIndexB: number): void {
    this._pairSet.add(pairKey(shapeIndexA, shapeIndexB));
  }

  /**
   * Remove a pair from the pair set (called by M3 when a contact is destroyed
   * so the same pair can be emitted again if the shapes re-overlap).
   */
  removePair(shapeIndexA: number, shapeIndexB: number): void {
    this._pairSet.delete(pairKey(shapeIndexA, shapeIndexB));
  }

  /**
   * Query whether a pair currently exists in the pair set.
   * Exposed for M3 / narrow-phase use.
   */
  hasPair(shapeIndexA: number, shapeIndexB: number): boolean {
    return this._pairSet.has(pairKey(shapeIndexA, shapeIndexB));
  }

  // -------------------------------------------------------------------------
  // Tree rebuild (b2BroadPhase_RebuildTrees)
  // -------------------------------------------------------------------------

  /**
   * Trigger a full bottom-up rebuild of the dynamic and kinematic trees.
   * Mirrors `b2BroadPhase_RebuildTrees` (called explicitly when needed;
   * updatePairs already does an incremental rebuild each step).
   */
  rebuildTrees(): void {
    this._trees[DYNAMIC_BODY]!.rebuild(true);
    this._trees[KINEMATIC_BODY]!.rebuild(true);
  }

  // -------------------------------------------------------------------------
  // Accessors (b2BroadPhase_TestOverlap / GetShapeIndex / GetAABB)
  // -------------------------------------------------------------------------

  /**
   * Test whether two proxies' stored AABBs overlap.
   * Mirrors `b2BroadPhase_TestOverlap`.
   */
  testOverlap(keyA: number, keyB: number): boolean {
    const aabbA = this.getAABB(keyA);
    const aabbB = this.getAABB(keyB);
    return (
      aabbA.lowerBound.x <= aabbB.upperBound.x &&
      aabbB.lowerBound.x <= aabbA.upperBound.x &&
      aabbA.lowerBound.y <= aabbB.upperBound.y &&
      aabbB.lowerBound.y <= aabbA.upperBound.y
    );
  }

  /**
   * Retrieve the shape index stored as tree userData for the given proxy key.
   * Mirrors `b2BroadPhase_GetShapeIndex`.
   */
  getShapeIndex(key: number): number {
    return this._trees[proxyType(key)]!.getUserData(proxyId(key));
  }

  /**
   * Retrieve the stored fat AABB for the given proxy key.
   * Mirrors `b2DynamicTree_GetAABB` called via the proxy key.
   */
  getAABB(key: number): AABB {
    return this._trees[proxyType(key)]!.getAABB(proxyId(key));
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  // -------------------------------------------------------------------------
  // Move buffering (b2BufferMove / b2UnBufferMove)
  // -------------------------------------------------------------------------

  /** Buffer a moved/created proxy key for the next pair query.
   *  Mirrors `b2BufferMove` — no-op if already buffered. */
  private _bufferMove(key: number): void {
    if (!this._movedSet.has(key)) {
      this._movedSet.add(key);
      this._moveArray.push(key);
    }
  }

  /** Remove a proxy key from the move buffer (called on destroy).
   *  Mirrors `b2UnBufferMove`. */
  private _unBufferMove(key: number): void {
    if (this._movedSet.has(key)) {
      this._movedSet.delete(key);
      // Linear scan — matches box2d's approach; move buffers are small.
      const idx = this._moveArray.indexOf(key);
      if (idx !== -1) {
        this._moveArray.splice(idx, 1);
      }
    }
  }
}
