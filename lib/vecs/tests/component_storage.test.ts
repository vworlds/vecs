import { describe, expect, it } from "vitest";
import { World } from "../src/world/index.js";

describe("shared component storage", () => {
  it("agrees with entity storage across staging, overwrite, removal and destruction", () => {
    class Value {
      n = 1;
    }
    const world = new World();
    const key = world.component(Value);
    const store = key.meta._term._store;
    key.on("add", (entity, value) => {
      expect(store.get(entity)).toBe(value);
      expect(entity.components.get(key.eid)).toBe(value);
    });
    const all = Array.from({ length: 100 }, () => world.entity().add(Value));
    for (const entity of all) {
      expect(store.get(entity)).toBe(entity.get(Value));
    }
    const replacement = new Value();
    all[0]!.attach(replacement);
    expect(store.get(all[0]!)).toBe(replacement);
    all[1]!.remove(Value);
    expect(store.get(all[1]!)).toBeUndefined();
    all[2]!.destroy();
    expect(store.get(all[2]!)).toBeUndefined();
    expect(store.size).toBe(key.instanceCount());
    world.dispose();
    expect(store.size).toBe(0);
  });
});
