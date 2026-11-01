import { expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import { Networked } from "../src/index.js";
import { ReplicationSim } from "./harness/replication_sim.js";

class Position {
  @wireType("i32") public x = 0;
}

class Health {
  @wireType("i32") public hp = 100;
}

it("replicates different schemas independently through changes, removals and resets", () => {
  const small = new ReplicationSim({ networkComponents: [Position] });
  let large: ReplicationSim | undefined;
  try {
    const a = small.server.entity().add(Networked).set(Position, { x: 7 });
    const ca = small.addClient();
    small.run(300);
    expect(small.diffFromServer(ca)).toEqual([]);

    large = new ReplicationSim({ networkComponents: [Position, Health] });
    const b = large.server.entity().add(Networked).set(Position, { x: 19 }).add(Health);
    const cb = large.addClient();
    const settle = () => {
      small.run(300);
      large!.run(300);
      expect(small.diffFromServer(ca)).toEqual([]);
      expect(large!.diffFromServer(cb)).toEqual([]);
      expect(ca.stats.disconnects).toEqual([]);
      expect(cb.stats.disconnects).toEqual([]);
    };
    settle();
    a.set(Position, { x: 23 });
    b.set(Health, { hp: 31 });
    settle();
    a.remove(Position);
    b.remove(Health);
    settle();
    a.set(Position, { x: 37 });
    b.add(Health);
    settle();
    a.destroy();
    b.destroy();
    settle();
  } finally {
    large?.dispose();
    small.dispose();
  }
});
