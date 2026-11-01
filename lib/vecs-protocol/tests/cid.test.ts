import { describe, expect, it } from "vitest";
import { ALL_COMPONENTS, CidLayout } from "../src/cid.js";

describe("CidLayout", () => {
  it.each([2, 32, 64, 256, 1024, 2 ** 30])("round-trips bounds for %s", (minimum) => {
    const layout = new CidLayout(minimum);
    expect(layout.wireTypeShift).toBe(Math.log2(minimum));
    expect(layout.wireTypeMask).toBe(minimum - 1);
    expect(layout.maxWireType).toBe(minimum - 1);
    expect(layout.maxEntityId).toBe(2 ** (32 - Math.log2(minimum)) - 1);
    expect(layout.unpack(layout.pack(0, 0))).toEqual([0, 0]);
    expect(layout.pack(layout.maxEntityId, layout.maxWireType)).toBe(0xffffffff);
    expect(layout.unpack(0xffffffff)).toEqual([layout.maxEntityId, layout.maxWireType]);
    expect(() => layout.pack(layout.maxEntityId + 1, 0)).toThrow(/exceeds maximum/);
    expect(() => layout.pack(0, layout.maxWireType + 1)).toThrow(/exceeds maximum wire type/);
  });

  it("pins the 28-component sector schema's overflow limits", () => {
    const layout = new CidLayout(32);
    expect(layout.maxEntityId).toBe(134217727);
    expect(layout.maxWireType).toBe(31);
    expect(layout.unpack(layout.pack(134217727, 31))).toEqual([134217727, 31]);
    expect(() => layout.pack(134217728, 1)).toThrow(
      "cid_pack: entity id 134217728 exceeds maximum 134217727 for localComponentMin=32. " +
        "Increase localComponentMin or use a smaller entity id."
    );
    expect(() => layout.pack(1, 32)).toThrow(
      "cid_pack: wire type id 32 exceeds maximum wire type 31. " +
        "Ensure wire type id is less than localComponentMin=32."
    );
  });

  it("preserves negative-id checks and accepts the all-components sentinel", () => {
    const layout = new CidLayout(256);
    expect(() => layout.pack(-1, 0)).toThrow(/entity id must be non-negative/);
    expect(() => layout.pack(0, -1)).toThrow(/wire type id must be non-negative/);
    expect(layout.unpack(layout.pack(1000, ALL_COMPONENTS))).toEqual([1000, ALL_COMPONENTS]);
    for (const [eid, wireType] of [
      [1, 0],
      [255, 1],
      [1000, 100],
      [16777215, 255],
    ]) {
      expect(layout.unpack(layout.pack(eid, wireType))).toEqual([eid, wireType]);
    }
    expect(() => layout.pack(2 ** 30, 0)).toThrow(/exceeds maximum/);
  });

  it.each([0, 1, -2, 3, 2.5, NaN, Infinity, 2 ** 31, 2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER])(
    "rejects %s without affecting another layout",
    (minimum) => {
      const existing = new CidLayout(64);
      const packed = existing.pack(1234, 63);
      expect(() => new CidLayout(minimum)).toThrow(/localComponentMin/);
      expect(existing.pack(1234, 63)).toBe(packed);
      expect(existing.unpack(packed)).toEqual([1234, 63]);
      const next = new CidLayout(1024);
      expect(next.unpack(next.pack(1234, 1023))).toEqual([1234, 1023]);
      expect(existing.unpack(packed)).toEqual([1234, 63]);
    }
  );
});
