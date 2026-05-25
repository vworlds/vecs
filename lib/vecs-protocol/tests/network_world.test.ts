import { describe, expect, it } from "vitest";
import { cid_pack, NetworkWorld } from "../src/index.js";

class Position {}
class Velocity {}
class LocalOnly {}

describe("NetworkWorld", () => {
  it("registers network components in the network id pool", () => {
    const world = new NetworkWorld({ networkComponents: [Position] });

    expect(world.localComponentMin).toBe(2);
    expect(world.getComponentEid(Position)).toBe(1);
    expect(world.networkComponents).toEqual([{ Class: Position, type: 1 }]);
    expect(cid_pack(42, 1)).toBeGreaterThan(0);
  });

  it("uses local component and local entity pools after the network ranges", () => {
    const world = new NetworkWorld({
      networkComponents: [Position],
      entityIdStart: 1000,
      localEntityIdStart: 100_000,
    });
    const nextLocalComponentEid = world.peekNextEid("component");

    expect(nextLocalComponentEid).toBeGreaterThanOrEqual(world.localComponentMin);
    expect(world.component(LocalOnly).eid).toBe(nextLocalComponentEid);
    expect(world.pools).toContainEqual({ name: "module", min: 900, max: 999 });
    expect(world.getOrCreateEntity(1000).eid).toBe(1000);
    expect(world.entity().eid).toBe(100_000);
  });

  it("requires every NetworkWorld to use the same local component minimum", () => {
    expect(() => new NetworkWorld({ networkComponents: [Position] })).not.toThrow();
    expect(() => new NetworkWorld({ networkComponents: [Position, Velocity] })).toThrow(
      /does not match existing value/
    );
  });
});
