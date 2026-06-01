// Index allocator with per-slot generations. Mirrors box2d/src/id_pool.c
// (b2AllocId / b2FreeId, LIFO free list) and additionally tracks a generation
// per slot — box2d keeps the generation on the object; vecs-physics folds it
// into the pool so validity is a single `isValid(handle)` check.

import type { Handle } from "./handle.js";

/**
 * Allocates dense integer indices, reusing freed ones, and stamps each
 * allocation with a generation so a freed handle never aliases the slot's next
 * occupant.
 *
 * @typeParam H - The branded handle type this pool hands out (e.g. `BodyHandle`).
 */
export class IdPool<H extends Handle = Handle> {
  /** generation[index] — bumped on free so outstanding handles go stale. */
  private readonly _generations: number[] = [];

  /** Freed indices available for reuse (LIFO). */
  private readonly _freeList: number[] = [];

  /** High-water mark: one past the largest index ever allocated. */
  private _highWater = 0;

  /** Allocate a slot, reusing a freed index when one is available. */
  public allocate(): H {
    let index: number;
    if (this._freeList.length > 0) {
      index = this._freeList.pop()!;
    } else {
      index = this._highWater++;
      this._generations[index] = 0;
    }
    return { index, generation: this._generations[index]! } as H;
  }

  /** Return a slot to the free list, invalidating any outstanding handle to it. */
  public free(handle: H | number): void {
    const index = typeof handle === "number" ? handle : handle.index;
    this._generations[index] = (this._generations[index] ?? 0) + 1;
    this._freeList.push(index);
  }

  /** True when the handle still refers to a live allocation of its slot. */
  public isValid(handle: H): boolean {
    return (
      handle.index >= 0 &&
      handle.index < this._highWater &&
      this._generations[handle.index] === handle.generation
    );
  }

  /** Current generation of a slot (0 if never allocated). */
  public generationOf(index: number): number {
    return this._generations[index] ?? 0;
  }

  /** Number of slots currently allocated (capacity minus free list). */
  public get count(): number {
    return this._highWater - this._freeList.length;
  }

  /** One past the largest index ever handed out — the dense-array size to allocate. */
  public get capacity(): number {
    return this._highWater;
  }
}
