import { describe, expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import { Networked } from "../src/index.js";
import { ReplicationSim } from "./harness/replication_sim.js";

class Position {
  @wireType("i32") x = 0;
  @wireType("i32") y = 0;
}

describe.each([false, true])("assign replication (deferred=%s)", (deferred) => {
  it("sends no delta for equal values, but replicates differences and intentional set", () => {
    const sim = new ReplicationSim({ networkComponents: [Position] });
    try {
      const entity = sim.server.entity().add(Networked).set(Position, { x: 1, y: 2 });
      const client = sim.addClient();
      sim.run(500);
      expect(sim.diffFromServer(client)).toEqual([]);
      const sent = client.stats.framesSent;
      const write = (fn: () => void) => (deferred ? sim.server.defer(fn) : fn());
      write(() => entity.assign(Position, { x: 1 }));
      sim.run(200);
      expect(client.stats.framesSent).toBe(sent);
      write(() => entity.assign(Position, { x: 3 }));
      sim.run(200);
      expect(client.stats.framesSent).toBeGreaterThan(sent);
      expect(client.world.entity(entity.eid).get(Position)).toEqual({ x: 3, y: 2 });
      const changed = client.stats.framesSent;
      write(() => entity.set(Position, { x: 3 }));
      sim.run(200);
      expect(client.stats.framesSent).toBeGreaterThan(changed);
      expect(sim.diffFromServer(client)).toEqual([]);
    } finally {
      sim.dispose();
    }
  });
});
