import { describe, expect, it } from "vitest";
import { cid_pack, NetworkWorld } from "../src/index.js";

class Position {}
class Velocity {}
class LocalOnly {}

describe("NetworkWorld", () => {
  it("registers network components with wire type ids and auto-allocated eids", () => {
    const world = new NetworkWorld({ networkComponents: [Position] });

    expect(world.localComponentMin).toBe(2);
    expect(world.entity(Position).eid).toBeGreaterThanOrEqual(1);
    expect(world.networkComponents).toEqual([
      { Class: Position, wireType: 1, eid: world.entity(Position).eid },
    ]);
    expect(cid_pack(42, 1)).toBeGreaterThan(0);
  });

  it("uses local component and local entity pools after the network ranges", () => {
    const world = new NetworkWorld({
      networkComponents: [Position],
      entityIdStart: 1000,
      localEntityIdStart: 100_000,
    });
    const nextLocalComponentEid = world.peekNextEid("component");
    const nextLocalEntityEid = world.peekNextEid("entity");

    expect(nextLocalComponentEid).toBeGreaterThanOrEqual(1);
    expect(world.component(LocalOnly).eid).toBe(nextLocalComponentEid);
    expect(world.pools).toContainEqual({ name: "module", min: 900, max: 999 });
    expect(world.getOrCreateEntity(1000).eid).toBe(1000);
    expect(world.entity().eid).toBe(nextLocalEntityEid);
  });

  it("requires every NetworkWorld to use the same local component minimum", () => {
    expect(() => new NetworkWorld({ networkComponents: [Position] })).not.toThrow();
    expect(() => new NetworkWorld({ networkComponents: [Position, Velocity] })).toThrow(
      /does not match existing value/
    );
  });
});
