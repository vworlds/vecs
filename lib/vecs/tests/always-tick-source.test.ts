import { describe, expect, it } from "vitest";
import { World } from "../src/index.js";

describe("per-world always tick source", () => {
  it("gives each world its own every-frame clock", () => {
    const a = new World();
    const b = new World();
    expect(a.alwaysTickSource).not.toBe(b.alwaysTickSource);
    expect(a.system("s").cadence).toBe(a.alwaysTickSource);
  });

  it("keeps deltas separate when world B is stepped inside a system of world A", () => {
    const a = new World();
    const b = new World();
    const seen: string[] = [];
    a.system("a-first").run((_now, delta) => seen.push(`a-first:${delta}`));
    a.system("a-driver").run(() => b.progress(0, 7));
    a.system("a-last").run((_now, delta) => seen.push(`a-last:${delta}`));
    b.system("b-sys").run((_now, delta) => seen.push(`b:${delta}`));
    a.progress(0, 100);
    expect(seen).toEqual(["a-first:100", "b:7", "a-last:100"]);
  });
});
