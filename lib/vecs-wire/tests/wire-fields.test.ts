import { describe, expect, it } from "vitest";
import { tag, wireFields, wireType } from "../src/index.js";

describe("wireFields", () => {
  it("returns inherited fields in registration order without exposing the registry", () => {
    class Base {
      @wireType("f32") x = 1;
    }
    class Derived extends Base {
      @wireType(["string"]) labels: string[] = [];
    }
    new Derived();
    const fields = wireFields(Derived);
    expect(fields).toEqual([
      { key: "x", spec: "f32" },
      { key: "labels", spec: ["string"] },
    ]);
    expect(Object.isFrozen(fields)).toBe(true);
    expect(Object.isFrozen(fields[1])).toBe(true);
    expect(Object.isFrozen(fields[1].spec)).toBe(true);
    expect(wireFields(Base)).toEqual([{ key: "x", spec: "f32" }]);
  });
  it("returns empty arrays for unregistered classes and tags", () => {
    class Plain {}
    class Tag {}
    tag(Tag);
    expect(wireFields(Plain)).toEqual([]);
    expect(wireFields(Tag)).toEqual([]);
  });
});
