import { describe, expect, it } from "vitest";

import type { BodyHandle } from "../../src/util/handle.js";
import { IdPool } from "../../src/util/id_pool.js";

describe("IdPool", () => {
  it("hands out dense indices starting at zero", () => {
    const pool = new IdPool();
    expect(pool.allocate()).toEqual({ index: 0, generation: 0 });
    expect(pool.allocate()).toEqual({ index: 1, generation: 0 });
    expect(pool.allocate()).toEqual({ index: 2, generation: 0 });
    expect(pool.capacity).toBe(3);
    expect(pool.count).toBe(3);
  });

  it("reuses freed indices and bumps their generation", () => {
    const pool = new IdPool();
    const a = pool.allocate();
    const b = pool.allocate();
    expect(b).toEqual({ index: 1, generation: 0 });

    pool.free(b);
    expect(pool.count).toBe(1);

    const c = pool.allocate();
    // Same slot, next generation.
    expect(c).toEqual({ index: 1, generation: 1 });
    expect(pool.capacity).toBe(2); // no growth — slot reused
    expect(a.index).toBe(0);
  });

  it("invalidates a freed handle without affecting the live one", () => {
    const pool = new IdPool();
    const a = pool.allocate();
    const b = pool.allocate();

    pool.free(a);
    expect(pool.isValid(a)).toBe(false); // stale generation
    expect(pool.isValid(b)).toBe(true);

    const reused = pool.allocate(); // reuses slot 0 at generation 1
    expect(reused.index).toBe(0);
    expect(pool.isValid(reused)).toBe(true);
    expect(pool.isValid(a)).toBe(false); // old handle still stale
  });

  it("frees by index or by handle", () => {
    const pool = new IdPool();
    const a = pool.allocate();
    pool.free(a.index);
    expect(pool.isValid(a)).toBe(false);
    expect(pool.count).toBe(0);
  });

  it("carries branded handle types", () => {
    const bodies = new IdPool<BodyHandle>();
    const h: BodyHandle = bodies.allocate();
    expect(bodies.isValid(h)).toBe(true);
  });
});
