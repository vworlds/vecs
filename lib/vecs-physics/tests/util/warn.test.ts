import { describe, expect, it } from "vitest";

import { WarnDedupe } from "../../src/util/warn.js";

describe("WarnDedupe", () => {
  it("emits a formatted message once per (eid, code) and suppresses duplicates", () => {
    const messages: string[] = [];
    const warn = new WarnDedupe((m) => messages.push(m));

    expect(warn.warnOnce(7, "shape-without-parent-body", "no body")).toBe(true);
    expect(warn.warnOnce(7, "shape-without-parent-body", "no body")).toBe(false);
    expect(warn.warnOnce(7, "shape-without-parent-body", "no body")).toBe(false);

    expect(messages).toEqual(["[vecs-physics] shape-without-parent-body: no body"]);
  });

  it("tracks codes independently per entity and per code", () => {
    const messages: string[] = [];
    const warn = new WarnDedupe((m) => messages.push(m));

    warn.warnOnce(1, "a", "first");
    warn.warnOnce(1, "b", "second"); // same entity, different code
    warn.warnOnce(2, "a", "third"); // different entity, same code

    expect(messages).toHaveLength(3);
    expect(warn.has(1, "a")).toBe(true);
    expect(warn.has(1, "b")).toBe(true);
    expect(warn.has(2, "a")).toBe(true);
    expect(warn.has(2, "b")).toBe(false);
  });

  it("re-arms a code so it warns again after the structure breaks anew", () => {
    const messages: string[] = [];
    const warn = new WarnDedupe((m) => messages.push(m));

    warn.warnOnce(3, "polygon-invalid", "bad hull");
    warn.rearm(3, "polygon-invalid");
    expect(warn.has(3, "polygon-invalid")).toBe(false);
    expect(warn.warnOnce(3, "polygon-invalid", "bad hull again")).toBe(true);

    expect(messages).toEqual([
      "[vecs-physics] polygon-invalid: bad hull",
      "[vecs-physics] polygon-invalid: bad hull again",
    ]);
  });

  it("clears all state", () => {
    const warn = new WarnDedupe(() => {});
    warn.warnOnce(1, "a", "x");
    warn.clear();
    expect(warn.has(1, "a")).toBe(false);
  });
});
