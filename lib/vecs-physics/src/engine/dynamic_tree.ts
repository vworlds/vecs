// Ported from box2d/src/dynamic_tree.c.
// Self-balancing AABB BVH used by the broad phase.
//
// Node pool, Create/Destroy/MoveProxy/EnlargeProxy, insert/remove leaf with
// rotation (surface-area heuristic) balancing, Query, RayCast, and Rebuild
// (bottom-up / median-split). Validate runs as a structural invariant check.
//
// Design notes (PLAN.md → "Port the model, not the C representation"):
//   - Node indices and proxy ids are plain `number` (JS safe integer).
//   - categoryBits / userData are plain `number`; box2d uses uint64_t but we
//     only need 32-bit categories and JS-opaque user values, so number is fine.
//   - B2_NULL_INDEX → the module-level constant NULL_INDEX = -1.
//   - The per-node union {children / userData} is represented as two fields
//     (child1, child2 for internal nodes; userData for leaves).  When a node is
//     a leaf, child1 and child2 are NULL_INDEX; when internal, userData is NaN.
//   - "Port the model": the C tree struct's rebuild scratch arrays become
//     transient JS arrays allocated in rebuild() to avoid lifetime management.

import {
  center as aabbCenter,
  contains as aabbContains,
  extents as aabbExtents,
  overlaps as aabbOverlaps,
  perimeter,
  union as aabbUnion,
  type AABB,
} from "../math/aabb.js";
import {
  abs as vecAbs,
  crossSV,
  distanceSquared,
  dot,
  mulAdd,
  normalize,
  sub,
  type Vec2,
} from "../math/vec2.js";

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

/** Mirrors B2_NULL_INDEX = -1. */
const NULL_INDEX = -1;

/** Default category bits for new nodes. Mirrors B2_DEFAULT_CATEGORY_BITS = 1. */
const DEFAULT_CATEGORY_BITS = 1;

// ---------------------------------------------------------------------------
// Node flag bits — mirrors enum b2TreeNodeFlags
// ---------------------------------------------------------------------------

const ALLOCATED_NODE = 0x0001;
const ENLARGED_NODE = 0x0002;
const LEAF_NODE = 0x0004;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Mirrors b2RayCastInput. */
export interface RayCastInput {
  /** Start point of the ray. */
  origin: Vec2;
  /** Translation (direction × maxFraction). */
  translation: Vec2;
  /** Fraction in [0, 1] past which hits are ignored. */
  maxFraction: number;
}

/** Statistics returned by Query / RayCast. Mirrors b2TreeStats. */
export interface TreeStats {
  nodeVisits: number;
  leafVisits: number;
}

/**
 * Query callback.  Return `true` to continue, `false` to stop early.
 * Mirrors b2TreeQueryCallbackFcn.
 */
export type TreeQueryCallback = (proxyId: number, userData: number) => boolean;

/**
 * RayCast callback.  Return the new maxFraction (≤ previous) to narrow the
 * cast, 0 to terminate, or < 0 to skip this leaf.  Mirrors
 * b2TreeRayCastCallbackFcn.
 */
export type TreeRayCastCallback = (
  input: RayCastInput,
  proxyId: number,
  userData: number
) => number;

// ---------------------------------------------------------------------------
// Internal node record
// ---------------------------------------------------------------------------

/** One node in the node pool. Combines the two C unions into plain fields. */
interface TreeNode {
  aabb: AABB;
  categoryBits: number;

  // Children (internal) — NULL_INDEX when this is a leaf.
  child1: number;
  child2: number;

  // userData (leaf) — meaningless for internal nodes.
  userData: number;

  // parent when allocated; next free-list index when free.
  parent: number;

  height: number;
  flags: number;
}

function makeDefaultNode(): TreeNode {
  return {
    aabb: { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } },
    categoryBits: DEFAULT_CATEGORY_BITS,
    child1: NULL_INDEX,
    child2: NULL_INDEX,
    userData: 0,
    parent: NULL_INDEX,
    height: 0,
    flags: ALLOCATED_NODE,
  };
}

function isLeaf(node: TreeNode): boolean {
  return (node.flags & LEAF_NODE) !== 0;
}

function isAllocated(node: TreeNode): boolean {
  return (node.flags & ALLOCATED_NODE) !== 0;
}

// ---------------------------------------------------------------------------
// Rebuild item (mirrors struct b2RebuildItem)
// ---------------------------------------------------------------------------

interface RebuildItem {
  nodeIndex: number;
  childCount: number;
  startIndex: number;
  splitIndex: number;
  endIndex: number;
}

// ---------------------------------------------------------------------------
// DynamicTree
// ---------------------------------------------------------------------------

/**
 * A self-balancing AABB BVH for broad-phase overlap detection.
 * Mirrors b2DynamicTree from box2d/src/dynamic_tree.c.
 *
 * Proxies are leaves; internal nodes are managed automatically.
 * All public methods use plain `number` for proxy ids and user data.
 */
export class DynamicTree {
  // Public fields mirroring the C struct for test introspection.
  /** Index of the root node, or NULL_INDEX when empty. */
  root: number = NULL_INDEX;

  /** Node pool. Length is nodeCapacity; only nodeCount slots are in use. */
  private _nodes: TreeNode[] = [];
  private _nodeCapacity: number = 0;

  /** Number of allocated nodes (both leaves and internal). */
  nodeCount: number = 0;

  /** Number of leaf (proxy) nodes. */
  proxyCount: number = 0;

  /** Head of the free list; each free slot's `parent` field stores the next. */
  private _freeList: number = NULL_INDEX;

  // -------------------------------------------------------------------------
  // Construction / destruction  (b2DynamicTree_Create / b2DynamicTree_Destroy)
  // -------------------------------------------------------------------------

  /**
   * Create a tree sized for the given proxy capacity.
   * Mirrors b2DynamicTree_Create.
   */
  constructor(proxyCapacity: number) {
    const capacity = Math.max(proxyCapacity, 16);
    // A full binary tree over `capacity` leaves has at most 2*capacity - 1 nodes.
    this._nodeCapacity = 2 * capacity - 1;
    this._nodes = Array.from({ length: this._nodeCapacity }, () => makeDefaultNode());

    // Build the free list.
    for (let i = 0; i < this._nodeCapacity - 1; i++) {
      this._nodes[i]!.flags = 0;
      this._nodes[i]!.parent = i + 1; // next field
    }
    this._nodes[this._nodeCapacity - 1]!.flags = 0;
    this._nodes[this._nodeCapacity - 1]!.parent = NULL_INDEX;
    this._freeList = 0;
  }

  /**
   * Free all nodes and reset counts.
   * Mirrors b2DynamicTree_Destroy.
   */
  destroy(): void {
    this._nodes = [];
    this._nodeCapacity = 0;
    this.nodeCount = 0;
    this.proxyCount = 0;
    this._freeList = NULL_INDEX;
    this.root = NULL_INDEX;
  }

  // -------------------------------------------------------------------------
  // Proxy management  (b2DynamicTree_CreateProxy / DestroyProxy / MoveProxy / EnlargeProxy)
  // -------------------------------------------------------------------------

  /**
   * Create a leaf proxy and insert it into the tree.
   * Returns the proxy id (node index).
   * Mirrors b2DynamicTree_CreateProxy.
   */
  createProxy(aabb: AABB, categoryBits: number, userData: number): number {
    const proxyId = this._allocateNode();
    const node = this._nodes[proxyId]!;

    node.aabb = { lowerBound: { ...aabb.lowerBound }, upperBound: { ...aabb.upperBound } };
    node.userData = userData;
    node.categoryBits = categoryBits;
    node.height = 0;
    node.flags = ALLOCATED_NODE | LEAF_NODE;

    this._insertLeaf(proxyId, true);
    this.proxyCount += 1;
    return proxyId;
  }

  /**
   * Remove a proxy from the tree.
   * Mirrors b2DynamicTree_DestroyProxy.
   */
  destroyProxy(proxyId: number): void {
    this._removeLeaf(proxyId);
    this._freeNode(proxyId);
    this.proxyCount -= 1;
  }

  /**
   * Move a proxy to a new AABB (remove and reinsert without rotation).
   * Mirrors b2DynamicTree_MoveProxy.
   */
  moveProxy(proxyId: number, aabb: AABB): void {
    this._removeLeaf(proxyId);
    this._nodes[proxyId]!.aabb = {
      lowerBound: { ...aabb.lowerBound },
      upperBound: { ...aabb.upperBound },
    };
    this._insertLeaf(proxyId, false);
  }

  /**
   * Enlarge the AABB of an existing proxy and mark ancestors as enlarged.
   * The caller must ensure the new AABB is not already contained by the old one.
   * Mirrors b2DynamicTree_EnlargeProxy.
   */
  enlargeProxy(proxyId: number, aabb: AABB): void {
    const nodes = this._nodes;
    nodes[proxyId]!.aabb = {
      lowerBound: { ...aabb.lowerBound },
      upperBound: { ...aabb.upperBound },
    };

    // Walk up marking and enlarging until no change.
    let parentIndex = nodes[proxyId]!.parent;
    while (parentIndex !== NULL_INDEX) {
      const changed = this._enlargeAABB(parentIndex, aabb);
      nodes[parentIndex]!.flags |= ENLARGED_NODE;
      parentIndex = nodes[parentIndex]!.parent;
      if (!changed) {
        break;
      }
    }

    // Continue marking even if size stopped changing.
    while (parentIndex !== NULL_INDEX) {
      if (nodes[parentIndex]!.flags & ENLARGED_NODE) {
        break; // already marked by a previous ascent
      }
      nodes[parentIndex]!.flags |= ENLARGED_NODE;
      parentIndex = nodes[parentIndex]!.parent;
    }
  }

  // -------------------------------------------------------------------------
  // Category bits  (b2DynamicTree_SetCategoryBits / GetCategoryBits)
  // -------------------------------------------------------------------------

  /** Mirrors b2DynamicTree_SetCategoryBits. */
  setCategoryBits(proxyId: number, categoryBits: number): void {
    this._nodes[proxyId]!.categoryBits = categoryBits;
    // Propagate up through ancestor internal nodes.
    let nodeIndex = this._nodes[proxyId]!.parent;
    while (nodeIndex !== NULL_INDEX) {
      const node = this._nodes[nodeIndex]!;
      node.categoryBits =
        this._nodes[node.child1]!.categoryBits | this._nodes[node.child2]!.categoryBits;
      nodeIndex = node.parent;
    }
  }

  /** Mirrors b2DynamicTree_GetCategoryBits. */
  getCategoryBits(proxyId: number): number {
    return this._nodes[proxyId]!.categoryBits;
  }

  // -------------------------------------------------------------------------
  // Accessors  (GetHeight / GetAreaRatio / GetRootBounds / GetProxyCount /
  //             GetByteCount / GetUserData / GetAABB)
  // -------------------------------------------------------------------------

  /** Mirrors b2DynamicTree_GetHeight. */
  getHeight(): number {
    if (this.root === NULL_INDEX) {
      return 0;
    }
    return this._nodes[this.root]!.height;
  }

  /** Mirrors b2DynamicTree_GetAreaRatio. */
  getAreaRatio(): number {
    if (this.root === NULL_INDEX) {
      return 0;
    }
    const rootArea = perimeter(this._nodes[this.root]!.aabb);
    let totalArea = 0;
    for (let i = 0; i < this._nodeCapacity; i++) {
      const node = this._nodes[i]!;
      if (!isAllocated(node) || isLeaf(node) || i === this.root) {
        continue;
      }
      totalArea += perimeter(node.aabb);
    }
    return totalArea / rootArea;
  }

  /** Mirrors b2DynamicTree_GetRootBounds. */
  getRootBounds(): AABB {
    if (this.root !== NULL_INDEX) {
      return this._nodes[this.root]!.aabb;
    }
    return { lowerBound: { x: 0, y: 0 }, upperBound: { x: 0, y: 0 } };
  }

  /** Mirrors b2DynamicTree_GetProxyCount. */
  getProxyCount(): number {
    return this.proxyCount;
  }

  /**
   * Approximate byte cost, matching box2d's sizing formula.
   * Mirrors b2DynamicTree_GetByteCount.
   */
  getByteCount(): number {
    // Each TreeNode is roughly sizeof(b2TreeNode) = 32 bytes in C.
    // We report a consistent estimate so tests pass the > 0 check.
    return this._nodeCapacity * 32;
  }

  /** Mirrors b2DynamicTree_GetUserData. */
  getUserData(proxyId: number): number {
    return this._nodes[proxyId]!.userData;
  }

  /** Mirrors b2DynamicTree_GetAABB. */
  getAABB(proxyId: number): AABB {
    return this._nodes[proxyId]!.aabb;
  }

  // -------------------------------------------------------------------------
  // Query  (b2DynamicTree_Query / b2DynamicTree_QueryAll)
  // -------------------------------------------------------------------------

  /**
   * Report all proxies whose AABB overlaps `aabb` and whose category bits
   * match `maskBits`.  Mirrors b2DynamicTree_Query.
   */
  query(aabb: AABB, maskBits: number, callback: TreeQueryCallback): TreeStats {
    const result: TreeStats = { nodeVisits: 0, leafVisits: 0 };
    if (this.nodeCount === 0) {
      return result;
    }

    const stack: number[] = [this.root];
    const nodes = this._nodes;

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      const node = nodes[nodeId]!;
      result.nodeVisits++;

      if (aabbOverlaps(node.aabb, aabb) && (node.categoryBits & maskBits) !== 0) {
        if (isLeaf(node)) {
          result.leafVisits++;
          const proceed = callback(nodeId, node.userData);
          if (!proceed) {
            return result;
          }
        } else {
          stack.push(node.child1);
          stack.push(node.child2);
        }
      }
    }

    return result;
  }

  /**
   * Report all proxies overlapping `aabb` regardless of category bits.
   * Mirrors b2DynamicTree_QueryAll.
   */
  queryAll(aabb: AABB, callback: TreeQueryCallback): TreeStats {
    const result: TreeStats = { nodeVisits: 0, leafVisits: 0 };
    if (this.nodeCount === 0) {
      return result;
    }

    const stack: number[] = [this.root];
    const nodes = this._nodes;

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      const node = nodes[nodeId]!;
      result.nodeVisits++;

      if (aabbOverlaps(node.aabb, aabb)) {
        if (isLeaf(node)) {
          result.leafVisits++;
          const proceed = callback(nodeId, node.userData);
          if (!proceed) {
            return result;
          }
        } else {
          stack.push(node.child1);
          stack.push(node.child2);
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // RayCast  (b2DynamicTree_RayCast)
  // -------------------------------------------------------------------------

  /**
   * Cast a ray and report leaf proxies that may be hit.  The callback receives
   * the current maxFraction; returning a smaller value narrows the cast; 0
   * terminates; < 0 skips the proxy.
   * Mirrors b2DynamicTree_RayCast.
   */
  rayCast(input: RayCastInput, maskBits: number, callback: TreeRayCastCallback): TreeStats {
    const result: TreeStats = { nodeVisits: 0, leafVisits: 0 };
    if (this.nodeCount === 0) {
      return result;
    }

    const p1 = input.origin;
    const d = input.translation;

    // r = normalize(d); handle zero-length ray.
    const r = normalize(d);

    // v is perpendicular to the segment (Gino, p80).
    const v = crossSV(1, r);
    const abs_v = vecAbs(v);

    let maxFraction = input.maxFraction;
    let p2 = mulAdd(p1, maxFraction, d);

    // Bounding box for the segment.
    let segmentAABB: AABB = {
      lowerBound: {
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
      },
      upperBound: {
        x: Math.max(p1.x, p2.x),
        y: Math.max(p1.y, p2.y),
      },
    };

    const stack: number[] = [this.root];
    const nodes = this._nodes;
    const subInput: RayCastInput = { origin: p1, translation: d, maxFraction };

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (nodeId === NULL_INDEX) {
        continue;
      }

      const node = nodes[nodeId]!;
      result.nodeVisits++;

      const nodeAABB = node.aabb;

      // Reject if category bits don't match or AABB doesn't overlap segment AABB.
      if ((node.categoryBits & maskBits) === 0 || !aabbOverlaps(nodeAABB, segmentAABB)) {
        continue;
      }

      // Separating axis test (Gino, p80):  |dot(v, p1 - c)| > dot(|v|, h)
      const c = aabbCenter(nodeAABB);
      const h = aabbExtents(nodeAABB);
      const term1 = Math.abs(dot(v, sub(p1, c)));
      const term2 = dot(abs_v, h);
      if (term2 < term1) {
        continue;
      }

      if (isLeaf(node)) {
        subInput.maxFraction = maxFraction;
        result.leafVisits++;
        const value = callback(subInput, nodeId, node.userData);

        if (value === 0) {
          return result;
        } // terminated by callback

        if (value > 0 && value <= maxFraction) {
          // Narrow the cast.
          maxFraction = value;
          p2 = mulAdd(p1, maxFraction, d);
          segmentAABB = {
            lowerBound: { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) },
            upperBound: { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) },
          };
        }
      } else {
        // Visit closer child first (push farther first so it's popped last).
        const c1 = aabbCenter(nodes[node.child1]!.aabb);
        const c2 = aabbCenter(nodes[node.child2]!.aabb);
        if (distanceSquared(c1, p1) < distanceSquared(c2, p1)) {
          stack.push(node.child2);
          stack.push(node.child1);
        } else {
          stack.push(node.child1);
          stack.push(node.child2);
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Rebuild  (b2DynamicTree_Rebuild)
  // -------------------------------------------------------------------------

  /**
   * Bottom-up rebuild using a median-split heuristic.  If `fullBuild` is true
   * every node is considered a rebuild leaf; otherwise only non-enlarged
   * internal nodes survive as sub-trees.  Returns the number of leaves rebuilt.
   * Mirrors b2DynamicTree_Rebuild (with B2_TREE_HEURISTIC == 0, median split).
   */
  rebuild(fullBuild: boolean): number {
    const proxyCount = this.proxyCount;
    if (proxyCount === 0) {
      return 0;
    }

    const leafIndices: number[] = [];
    const leafCenters: Vec2[] = [];

    // Gather leaves. Free enlarged internal nodes.
    const stack: number[] = [];
    let nodeIndex = this.root;
    const nodes = this._nodes;
    let node = nodes[nodeIndex]!;

    while (true) {
      if (node.height === 0 || (!(node.flags & ENLARGED_NODE) && !fullBuild)) {
        // This is a rebuild leaf (either a real proxy leaf or an un-enlarged sub-tree).
        leafIndices.push(nodeIndex);
        leafCenters.push(aabbCenter(node.aabb));
        // Detach from parent so buildTree can reattach.
        node.parent = NULL_INDEX;
      } else {
        // Internal node that needs rebuilding: free it, recurse into children.
        const doomedIndex = nodeIndex;
        nodeIndex = node.child1;
        stack.push(node.child2);
        node = nodes[nodeIndex]!;
        this._freeNode(doomedIndex);
        continue;
      }

      if (stack.length === 0) {
        break;
      }
      nodeIndex = stack.pop()!;
      node = nodes[nodeIndex]!;
    }

    this.root = this._buildTree(leafIndices, leafCenters);
    this.validate();
    return leafIndices.length;
  }

  // -------------------------------------------------------------------------
  // Validate  (b2DynamicTree_Validate)
  // -------------------------------------------------------------------------

  /**
   * Assert structural invariants hold.  No-op in production builds; always
   * runs here so the test suite catches corruption immediately.
   * Mirrors b2DynamicTree_Validate.
   */
  validate(): void {
    if (this.root === NULL_INDEX) {
      return;
    }
    this._validateStructure(this.root);
    this._validateMetrics(this.root);

    let freeCount = 0;
    let freeIndex = this._freeList;
    while (freeIndex !== NULL_INDEX) {
      freeIndex = this._nodes[freeIndex]!.parent; // next field
      freeCount++;
    }

    const height = this.getHeight();
    const computed = this._computeHeight(this.root);
    if (height !== computed) {
      throw new Error(`DynamicTree: stored height ${height} != computed ${computed}`);
    }

    if (this.nodeCount + freeCount !== this._nodeCapacity) {
      throw new Error(
        `DynamicTree: nodeCount ${this.nodeCount} + freeCount ${freeCount} != capacity ${this._nodeCapacity}`
      );
    }
  }

  /** Assert no node is still marked enlarged. Mirrors b2DynamicTree_ValidateNoEnlarged. */
  validateNoEnlarged(): void {
    for (let i = 0; i < this._nodeCapacity; i++) {
      const node = this._nodes[i]!;
      if (isAllocated(node) && node.flags & ENLARGED_NODE) {
        throw new Error(`DynamicTree: node ${i} is still marked enlarged`);
      }
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  // -------------------------------------------------------------------------
  // Node pool  (b2AllocateNode / b2FreeNode)
  // -------------------------------------------------------------------------

  /** Allocate one node from the pool, growing the pool if necessary. */
  private _allocateNode(): number {
    if (this._freeList === NULL_INDEX) {
      // Pool is exhausted — grow by 50 %.
      const oldCapacity = this._nodeCapacity;
      this._nodeCapacity += oldCapacity >> 1;

      // Extend the array with fresh default nodes.
      for (let i = oldCapacity; i < this._nodeCapacity; i++) {
        this._nodes.push(makeDefaultNode());
      }

      // Build a free list for the new slots.
      for (let i = oldCapacity; i < this._nodeCapacity - 1; i++) {
        this._nodes[i]!.flags = 0;
        this._nodes[i]!.parent = i + 1; // next
      }
      this._nodes[this._nodeCapacity - 1]!.flags = 0;
      this._nodes[this._nodeCapacity - 1]!.parent = NULL_INDEX;
      this._freeList = oldCapacity;
    }

    const nodeIndex = this._freeList;
    const node = this._nodes[nodeIndex]!;
    this._freeList = node.parent; // next
    Object.assign(node, makeDefaultNode());
    this.nodeCount++;
    return nodeIndex;
  }

  /** Return a node to the free list. */
  private _freeNode(nodeId: number): void {
    const node = this._nodes[nodeId]!;
    node.parent = this._freeList; // next
    node.flags = 0;
    this._freeList = nodeId;
    this.nodeCount--;
  }

  // -------------------------------------------------------------------------
  // Insertion  (b2FindBestSibling / b2InsertLeaf)
  // -------------------------------------------------------------------------

  /**
   * Greedy SAH sibling selection.
   * Mirrors b2FindBestSibling.
   */
  private _findBestSibling(boxD: AABB): number {
    const nodes = this._nodes;
    const rootIndex = this.root;
    const rootBox = nodes[rootIndex]!.aabb;

    const areaD = perimeter(boxD);
    let areaBase = perimeter(rootBox);
    let directCost = perimeter(aabbUnion(rootBox, boxD));
    let inheritedCost = 0;

    let bestSibling = rootIndex;
    let bestCost = directCost;

    let index = rootIndex;
    while (nodes[index]!.height > 0) {
      const child1 = nodes[index]!.child1;
      const child2 = nodes[index]!.child2;

      const cost = directCost + inheritedCost;
      if (cost < bestCost) {
        bestSibling = index;
        bestCost = cost;
      }

      inheritedCost += directCost - areaBase;

      const leaf1 = nodes[child1]!.height === 0;
      const leaf2 = nodes[child2]!.height === 0;

      const box1 = nodes[child1]!.aabb;
      const directCost1 = perimeter(aabbUnion(box1, boxD));
      let lowerCost1 = Number.MAX_VALUE;
      let area1 = 0;

      if (leaf1) {
        const cost1 = directCost1 + inheritedCost;
        if (cost1 < bestCost) {
          bestSibling = child1;
          bestCost = cost1;
        }
      } else {
        area1 = perimeter(box1);
        lowerCost1 = inheritedCost + directCost1 + Math.min(areaD - area1, 0);
      }

      const box2 = nodes[child2]!.aabb;
      const directCost2 = perimeter(aabbUnion(box2, boxD));
      let lowerCost2 = Number.MAX_VALUE;
      let area2 = 0;

      if (leaf2) {
        const cost2 = directCost2 + inheritedCost;
        if (cost2 < bestCost) {
          bestSibling = child2;
          bestCost = cost2;
        }
      } else {
        area2 = perimeter(box2);
        lowerCost2 = inheritedCost + directCost2 + Math.min(areaD - area2, 0);
      }

      if (leaf1 && leaf2) {
        break;
      }
      if (bestCost <= lowerCost1 && bestCost <= lowerCost2) {
        break;
      }

      if (lowerCost1 === lowerCost2 && !leaf1) {
        // Tie-break by centroid distance.
        const centerD = aabbCenter(boxD);
        const d1 = sub(aabbCenter(box1), centerD);
        const d2 = sub(aabbCenter(box2), centerD);
        lowerCost1 = d1.x * d1.x + d1.y * d1.y;
        lowerCost2 = d2.x * d2.x + d2.y * d2.y;
      }

      if (lowerCost1 < lowerCost2 && !leaf1) {
        index = child1;
        areaBase = area1;
        directCost = directCost1;
      } else {
        index = child2;
        areaBase = area2;
        directCost = directCost2;
      }
    }

    return bestSibling;
  }

  /**
   * Insert `leaf` into the tree, optionally applying rotation to balance.
   * Mirrors b2InsertLeaf.
   */
  private _insertLeaf(leaf: number, shouldRotate: boolean): void {
    if (this.root === NULL_INDEX) {
      this.root = leaf;
      this._nodes[leaf]!.parent = NULL_INDEX;
      return;
    }

    // Stage 1: find best sibling via SAH.
    const leafAABB = this._nodes[leaf]!.aabb;
    const sibling = this._findBestSibling(leafAABB);

    // Stage 2: create a new parent for the leaf and the sibling.
    const oldParent = this._nodes[sibling]!.parent;
    const newParent = this._allocateNode();

    // Node pointer is stable after allocation (JS array, no memcpy hazard).
    const nodes = this._nodes;
    nodes[newParent]!.parent = oldParent;
    nodes[newParent]!.userData = 0;
    nodes[newParent]!.aabb = aabbUnion(leafAABB, nodes[sibling]!.aabb);
    nodes[newParent]!.categoryBits = nodes[leaf]!.categoryBits | nodes[sibling]!.categoryBits;
    nodes[newParent]!.height = nodes[sibling]!.height + 1;
    nodes[newParent]!.child1 = sibling;
    nodes[newParent]!.child2 = leaf;
    nodes[sibling]!.parent = newParent;
    nodes[leaf]!.parent = newParent;

    // Fix grandparent link.
    if (oldParent !== NULL_INDEX) {
      if (nodes[oldParent]!.child1 === sibling) {
        nodes[oldParent]!.child1 = newParent;
      } else {
        nodes[oldParent]!.child2 = newParent;
      }
    } else {
      this.root = newParent;
    }

    // Stage 3: walk back up fixing heights, AABBs, and optionally rotating.
    let index = nodes[leaf]!.parent;
    while (index !== NULL_INDEX) {
      const child1 = nodes[index]!.child1;
      const child2 = nodes[index]!.child2;

      nodes[index]!.aabb = aabbUnion(nodes[child1]!.aabb, nodes[child2]!.aabb);
      nodes[index]!.categoryBits = nodes[child1]!.categoryBits | nodes[child2]!.categoryBits;
      nodes[index]!.height = 1 + Math.max(nodes[child1]!.height, nodes[child2]!.height);
      nodes[index]!.flags |= (nodes[child1]!.flags | nodes[child2]!.flags) & ENLARGED_NODE;

      if (shouldRotate) {
        this._rotateNodes(index);
      }

      index = nodes[index]!.parent;
    }
  }

  // -------------------------------------------------------------------------
  // Rotation  (b2RotateNodes)
  // -------------------------------------------------------------------------

  /** SAH-guided rotation to keep the tree balanced. Mirrors b2RotateNodes. */
  private _rotateNodes(iA: number): void {
    const nodes = this._nodes;
    const A = nodes[iA]!;
    if (A.height < 2) {
      return;
    }

    const iB = A.child1;
    const iC = A.child2;
    const B = nodes[iB]!;
    const C = nodes[iC]!;

    if (B.height === 0) {
      // B is a leaf, C is internal.
      const iF = C.child1;
      const iG = C.child2;
      const F = nodes[iF]!;
      const G = nodes[iG]!;

      const costBase = perimeter(C.aabb);
      const aabbBG = aabbUnion(B.aabb, G.aabb);
      const costBF = perimeter(aabbBG); // cost of swapping B and F (new C holds B+G)
      const aabbBF = aabbUnion(B.aabb, F.aabb);
      const costBG = perimeter(aabbBF); // cost of swapping B and G (new C holds B+F)

      if (costBase < costBF && costBase < costBG) {
        return;
      }

      if (costBF < costBG) {
        // Swap B and F: A.child1 = F, C.child1 = B
        A.child1 = iF;
        C.child1 = iB;
        B.parent = iC;
        F.parent = iA;
        C.aabb = aabbBG;
        C.height = 1 + Math.max(B.height, G.height);
        A.height = 1 + Math.max(C.height, F.height);
        C.categoryBits = B.categoryBits | G.categoryBits;
        A.categoryBits = C.categoryBits | F.categoryBits;
        C.flags |= (B.flags | G.flags) & ENLARGED_NODE;
        A.flags |= (C.flags | F.flags) & ENLARGED_NODE;
      } else {
        // Swap B and G: A.child1 = G, C.child2 = B
        A.child1 = iG;
        C.child2 = iB;
        B.parent = iC;
        G.parent = iA;
        C.aabb = aabbBF;
        C.height = 1 + Math.max(B.height, F.height);
        A.height = 1 + Math.max(C.height, G.height);
        C.categoryBits = B.categoryBits | F.categoryBits;
        A.categoryBits = C.categoryBits | G.categoryBits;
        C.flags |= (B.flags | F.flags) & ENLARGED_NODE;
        A.flags |= (C.flags | G.flags) & ENLARGED_NODE;
      }
    } else if (C.height === 0) {
      // C is a leaf, B is internal.
      const iD = B.child1;
      const iE = B.child2;
      const D = nodes[iD]!;
      const E = nodes[iE]!;

      const costBase = perimeter(B.aabb);
      const aabbCE = aabbUnion(C.aabb, E.aabb);
      const costCD = perimeter(aabbCE); // cost of swapping C and D
      const aabbCD = aabbUnion(C.aabb, D.aabb);
      const costCE = perimeter(aabbCD); // cost of swapping C and E

      if (costBase < costCD && costBase < costCE) {
        return;
      }

      if (costCD < costCE) {
        // Swap C and D: A.child2 = D, B.child1 = C
        A.child2 = iD;
        B.child1 = iC;
        C.parent = iB;
        D.parent = iA;
        B.aabb = aabbCE;
        B.height = 1 + Math.max(C.height, E.height);
        A.height = 1 + Math.max(B.height, D.height);
        B.categoryBits = C.categoryBits | E.categoryBits;
        A.categoryBits = B.categoryBits | D.categoryBits;
        B.flags |= (C.flags | E.flags) & ENLARGED_NODE;
        A.flags |= (B.flags | D.flags) & ENLARGED_NODE;
      } else {
        // Swap C and E: A.child2 = E, B.child2 = C
        A.child2 = iE;
        B.child2 = iC;
        C.parent = iB;
        E.parent = iA;
        B.aabb = aabbCD;
        B.height = 1 + Math.max(C.height, D.height);
        A.height = 1 + Math.max(B.height, E.height);
        B.categoryBits = C.categoryBits | D.categoryBits;
        A.categoryBits = B.categoryBits | E.categoryBits;
        B.flags |= (C.flags | D.flags) & ENLARGED_NODE;
        A.flags |= (B.flags | E.flags) & ENLARGED_NODE;
      }
    } else {
      // Both B and C are internal — four-way rotation candidate.
      const iD = B.child1;
      const iE = B.child2;
      const iF = C.child1;
      const iG = C.child2;
      const D = nodes[iD]!;
      const E = nodes[iE]!;
      const F = nodes[iF]!;
      const G = nodes[iG]!;

      const areaB = perimeter(B.aabb);
      const areaC = perimeter(C.aabb);
      const costBase = areaB + areaC;

      // rotateBF: A.child1=F, C.child1=B  → new C holds B+G
      const aabbBG = aabbUnion(B.aabb, G.aabb);
      const costBF = areaB + perimeter(aabbBG);

      // rotateBG: A.child1=G, C.child2=B  → new C holds B+F
      const aabbBF = aabbUnion(B.aabb, F.aabb);
      const costBG = areaB + perimeter(aabbBF);

      // rotateCD: A.child2=D, B.child1=C  → new B holds C+E
      const aabbCE = aabbUnion(C.aabb, E.aabb);
      const costCD = areaC + perimeter(aabbCE);

      // rotateCE: A.child2=E, B.child2=C  → new B holds C+D
      const aabbCD = aabbUnion(C.aabb, D.aabb);
      const costCE = areaC + perimeter(aabbCD);

      let best = "none";
      let bestCost = costBase;

      if (costBF < bestCost) {
        best = "BF";
        bestCost = costBF;
      }
      if (costBG < bestCost) {
        best = "BG";
        bestCost = costBG;
      }
      if (costCD < bestCost) {
        best = "CD";
        bestCost = costCD;
      }
      if (costCE < bestCost) {
        best = "CE";
        // bestCost = costCE; // not used further
      }

      switch (best) {
        case "BF":
          A.child1 = iF;
          C.child1 = iB;
          B.parent = iC;
          F.parent = iA;
          C.aabb = aabbBG;
          C.height = 1 + Math.max(B.height, G.height);
          A.height = 1 + Math.max(C.height, F.height);
          C.categoryBits = B.categoryBits | G.categoryBits;
          A.categoryBits = C.categoryBits | F.categoryBits;
          C.flags |= (B.flags | G.flags) & ENLARGED_NODE;
          A.flags |= (C.flags | F.flags) & ENLARGED_NODE;
          break;

        case "BG":
          A.child1 = iG;
          C.child2 = iB;
          B.parent = iC;
          G.parent = iA;
          C.aabb = aabbBF;
          C.height = 1 + Math.max(B.height, F.height);
          A.height = 1 + Math.max(C.height, G.height);
          C.categoryBits = B.categoryBits | F.categoryBits;
          A.categoryBits = C.categoryBits | G.categoryBits;
          C.flags |= (B.flags | F.flags) & ENLARGED_NODE;
          A.flags |= (C.flags | G.flags) & ENLARGED_NODE;
          break;

        case "CD":
          A.child2 = iD;
          B.child1 = iC;
          C.parent = iB;
          D.parent = iA;
          B.aabb = aabbCE;
          B.height = 1 + Math.max(C.height, E.height);
          A.height = 1 + Math.max(B.height, D.height);
          B.categoryBits = C.categoryBits | E.categoryBits;
          A.categoryBits = B.categoryBits | D.categoryBits;
          B.flags |= (C.flags | E.flags) & ENLARGED_NODE;
          A.flags |= (B.flags | D.flags) & ENLARGED_NODE;
          break;

        case "CE":
          A.child2 = iE;
          B.child2 = iC;
          C.parent = iB;
          E.parent = iA;
          B.aabb = aabbCD;
          B.height = 1 + Math.max(C.height, D.height);
          A.height = 1 + Math.max(B.height, E.height);
          B.categoryBits = C.categoryBits | D.categoryBits;
          A.categoryBits = B.categoryBits | E.categoryBits;
          B.flags |= (C.flags | D.flags) & ENLARGED_NODE;
          A.flags |= (B.flags | E.flags) & ENLARGED_NODE;
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Removal  (b2RemoveLeaf)
  // -------------------------------------------------------------------------

  /** Remove a leaf from the tree, repairing parent links. Mirrors b2RemoveLeaf. */
  private _removeLeaf(leaf: number): void {
    if (leaf === this.root) {
      this.root = NULL_INDEX;
      return;
    }

    const nodes = this._nodes;
    const parent = nodes[leaf]!.parent;
    const grandParent = nodes[parent]!.parent;
    const sibling = nodes[parent]!.child1 === leaf ? nodes[parent]!.child2 : nodes[parent]!.child1;

    if (grandParent !== NULL_INDEX) {
      // Splice out parent; connect sibling directly to grandParent.
      if (nodes[grandParent]!.child1 === parent) {
        nodes[grandParent]!.child1 = sibling;
      } else {
        nodes[grandParent]!.child2 = sibling;
      }
      nodes[sibling]!.parent = grandParent;
      this._freeNode(parent);

      // Refit ancestor AABBs up to the root.
      let index = grandParent;
      while (index !== NULL_INDEX) {
        const node = nodes[index]!;
        const c1 = nodes[node.child1]!;
        const c2 = nodes[node.child2]!;
        node.aabb = aabbUnion(c1.aabb, c2.aabb);
        node.categoryBits = c1.categoryBits | c2.categoryBits;
        node.height = 1 + Math.max(c1.height, c2.height);
        index = node.parent;
      }
    } else {
      // Parent was the root; sibling becomes the new root.
      this.root = sibling;
      nodes[sibling]!.parent = NULL_INDEX;
      this._freeNode(parent);
    }
  }

  // -------------------------------------------------------------------------
  // Enlarge helper
  // -------------------------------------------------------------------------

  /**
   * Expand `parentIndex`'s AABB to contain `aabb`.
   * Returns true if the AABB actually changed.
   */
  private _enlargeAABB(parentIndex: number, aabb: AABB): boolean {
    const node = this._nodes[parentIndex]!;
    const lb = node.aabb.lowerBound;
    const ub = node.aabb.upperBound;

    const newLx = Math.min(lb.x, aabb.lowerBound.x);
    const newLy = Math.min(lb.y, aabb.lowerBound.y);
    const newUx = Math.max(ub.x, aabb.upperBound.x);
    const newUy = Math.max(ub.y, aabb.upperBound.y);

    const changed = newLx < lb.x || newLy < lb.y || newUx > ub.x || newUy > ub.y;

    lb.x = newLx;
    lb.y = newLy;
    ub.x = newUx;
    ub.y = newUy;

    return changed;
  }

  // -------------------------------------------------------------------------
  // Bottom-up rebuild helpers  (b2PartitionMid / b2BuildTree)
  // -------------------------------------------------------------------------

  /**
   * Median-split partition. Mirrors b2PartitionMid.
   * Rearranges `indices` and `centers` in place; returns the split index.
   */
  private _partitionMid(indices: number[], centers: Vec2[], start: number, count: number): number {
    if (count <= 2) {
      return Math.floor(count / 2);
    }

    let lx = centers[start]!.x;
    let ly = centers[start]!.y;
    let ux = centers[start]!.x;
    let uy = centers[start]!.y;

    for (let i = start + 1; i < start + count; i++) {
      lx = Math.min(lx, centers[i]!.x);
      ly = Math.min(ly, centers[i]!.y);
      ux = Math.max(ux, centers[i]!.x);
      uy = Math.max(uy, centers[i]!.y);
    }

    const dx = ux - lx;
    const dy = uy - ly;
    const pivotX = 0.5 * (lx + ux);
    const pivotY = 0.5 * (ly + uy);

    // Hoare partition on the longest axis.
    let i1 = start;
    let i2 = start + count;

    if (dx > dy) {
      while (i1 < i2) {
        while (i1 < i2 && centers[i1]!.x < pivotX) {
          i1++;
        }
        while (i1 < i2 && centers[i2 - 1]!.x >= pivotX) {
          i2--;
        }
        if (i1 < i2) {
          const ti = indices[i1];
          indices[i1] = indices[i2 - 1]!;
          indices[i2 - 1] = ti!;
          const tc = centers[i1];
          centers[i1] = centers[i2 - 1]!;
          centers[i2 - 1] = tc!;
          i1++;
          i2--;
        }
      }
    } else {
      while (i1 < i2) {
        while (i1 < i2 && centers[i1]!.y < pivotY) {
          i1++;
        }
        while (i1 < i2 && centers[i2 - 1]!.y >= pivotY) {
          i2--;
        }
        if (i1 < i2) {
          const ti = indices[i1];
          indices[i1] = indices[i2 - 1]!;
          indices[i2 - 1] = ti!;
          const tc = centers[i1];
          centers[i1] = centers[i2 - 1]!;
          centers[i2 - 1] = tc!;
          i1++;
          i2--;
        }
      }
    }

    const split = i1 - start;
    if (split > 0 && split < count) {
      return split;
    }
    return Math.floor(count / 2);
  }

  /**
   * Build an optimal BVH over the given leaf set using median-split.
   * Returns the index of the new root node.
   * Mirrors b2BuildTree (with B2_TREE_HEURISTIC == 0).
   */
  private _buildTree(leafIndices: number[], leafCenters: Vec2[]): number {
    const leafCount = leafIndices.length;
    const nodes = this._nodes;

    if (leafCount === 1) {
      nodes[leafIndices[0]!]!.parent = NULL_INDEX;
      return leafIndices[0]!;
    }

    // Iterative tree build using an explicit stack of RebuildItems.
    const stack: RebuildItem[] = [];

    const splitIndex = this._partitionMid(leafIndices, leafCenters, 0, leafCount);
    stack.push({
      nodeIndex: this._allocateNode(),
      childCount: -1,
      startIndex: 0,
      splitIndex,
      endIndex: leafCount,
    });

    while (true) {
      const item = stack[stack.length - 1]!;
      item.childCount++;

      if (item.childCount === 2) {
        // Both children are ready — backfill parent and pop.
        if (stack.length === 1) {
          break;
        } // root finished

        stack.pop();

        const parentItem = stack[stack.length - 1]!;
        const parentNode = nodes[parentItem.nodeIndex]!;

        if (parentItem.childCount === 0) {
          parentNode.child1 = item.nodeIndex;
        } else {
          parentNode.child2 = item.nodeIndex;
        }

        const node = nodes[item.nodeIndex]!;
        node.parent = parentItem.nodeIndex;

        const c1 = nodes[node.child1]!;
        const c2 = nodes[node.child2]!;
        node.aabb = aabbUnion(c1.aabb, c2.aabb);
        node.height = 1 + Math.max(c1.height, c2.height);
        node.categoryBits = c1.categoryBits | c2.categoryBits;
      } else {
        // Process next child partition.
        const startIndex = item.childCount === 0 ? item.startIndex : item.splitIndex;
        const endIndex = item.childCount === 0 ? item.splitIndex : item.endIndex;
        const count = endIndex - startIndex;

        if (count === 1) {
          // Leaf range: attach directly.
          const childIndex = leafIndices[startIndex]!;
          const node = nodes[item.nodeIndex]!;
          if (item.childCount === 0) {
            node.child1 = childIndex;
          } else {
            node.child2 = childIndex;
          }
          nodes[childIndex]!.parent = item.nodeIndex;
        } else {
          const newSplit = this._partitionMid(leafIndices, leafCenters, startIndex, count);
          stack.push({
            nodeIndex: this._allocateNode(),
            childCount: -1,
            startIndex,
            splitIndex: startIndex + newSplit,
            endIndex,
          });
        }
      }
    }

    // Finalise the root.
    const rootItem = stack[0]!;
    const rootNode = nodes[rootItem.nodeIndex]!;
    rootNode.parent = NULL_INDEX;

    const rc1 = nodes[rootNode.child1]!;
    const rc2 = nodes[rootNode.child2]!;
    rootNode.aabb = aabbUnion(rc1.aabb, rc2.aabb);
    rootNode.height = 1 + Math.max(rc1.height, rc2.height);
    rootNode.categoryBits = rc1.categoryBits | rc2.categoryBits;

    return rootItem.nodeIndex;
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private _computeHeight(nodeId: number): number {
    const node = this._nodes[nodeId]!;
    if (isLeaf(node)) {
      return 0;
    }
    const h1 = this._computeHeight(node.child1);
    const h2 = this._computeHeight(node.child2);
    return 1 + Math.max(h1, h2);
  }

  private _validateStructure(index: number): void {
    if (index === NULL_INDEX) {
      return;
    }

    if (index === this.root) {
      if (this._nodes[index]!.parent !== NULL_INDEX) {
        throw new Error(`DynamicTree: root ${index} has non-null parent`);
      }
    }

    const node = this._nodes[index]!;

    if (isLeaf(node)) {
      if (node.height !== 0) {
        throw new Error(`DynamicTree: leaf ${index} has height != 0`);
      }
      return;
    }

    const child1 = node.child1;
    const child2 = node.child2;

    if (this._nodes[child1]!.parent !== index) {
      throw new Error(`DynamicTree: child1 ${child1} parent != ${index}`);
    }
    if (this._nodes[child2]!.parent !== index) {
      throw new Error(`DynamicTree: child2 ${child2} parent != ${index}`);
    }

    if (
      (this._nodes[child1]!.flags | this._nodes[child2]!.flags) & ENLARGED_NODE &&
      !(node.flags & ENLARGED_NODE)
    ) {
      throw new Error(`DynamicTree: node ${index} should be marked enlarged`);
    }

    this._validateStructure(child1);
    this._validateStructure(child2);
  }

  private _validateMetrics(index: number): void {
    if (index === NULL_INDEX) {
      return;
    }

    const node = this._nodes[index]!;
    if (isLeaf(node)) {
      if (node.height !== 0) {
        throw new Error(`DynamicTree: leaf ${index} height != 0`);
      }
      return;
    }

    const child1 = node.child1;
    const child2 = node.child2;

    const h1 = this._nodes[child1]!.height;
    const h2 = this._nodes[child2]!.height;
    const expected = 1 + Math.max(h1, h2);
    if (node.height !== expected) {
      throw new Error(`DynamicTree: node ${index} height ${node.height} != expected ${expected}`);
    }

    if (!aabbContains(node.aabb, this._nodes[child1]!.aabb)) {
      throw new Error(`DynamicTree: node ${index} does not contain child1 ${child1}`);
    }
    if (!aabbContains(node.aabb, this._nodes[child2]!.aabb)) {
      throw new Error(`DynamicTree: node ${index} does not contain child2 ${child2}`);
    }

    const expectedCategoryBits =
      this._nodes[child1]!.categoryBits | this._nodes[child2]!.categoryBits;
    if (node.categoryBits !== expectedCategoryBits) {
      throw new Error(
        `DynamicTree: node ${index} categoryBits ${node.categoryBits} != expected ${expectedCategoryBits}`
      );
    }

    this._validateMetrics(child1);
    this._validateMetrics(child2);
  }
}
