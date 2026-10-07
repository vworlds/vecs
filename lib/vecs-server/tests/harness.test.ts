import { afterEach, describe, expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import { Networked } from "../src/index.js";
import { LossyLink, symmetric } from "./harness/lossy_link.js";
import { createRandom, deriveSeed } from "./harness/random.js";
import { ReplicationSim } from "./harness/replication_sim.js";
import { SimClock } from "./harness/sim_clock.js";

// The replication harness is what the loss and latency scenarios stand on, so these tests check
// that it does what it claims: events run in time order, links delay, drop and reorder as
// configured, and a seed reproduces a run exactly.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

describe("SimClock", () => {
  it("runs events in time order, and in schedule order at the same time", () => {
    const clock = new SimClock();
    const ran: string[] = [];
    clock.schedule(30, () => ran.push("c"));
    clock.schedule(10, () => ran.push("a1"));
    clock.schedule(10, () => ran.push("a2"));
    clock.schedule(20, () => ran.push("b"));

    clock.runUntil(25);

    expect(ran).toEqual(["a1", "a2", "b"]);
    expect(clock.now).toBe(25);

    clock.runUntil(100);
    expect(ran).toEqual(["a1", "a2", "b", "c"]);
  });

  it("sets `now` to each event's time while it runs", () => {
    const clock = new SimClock();
    const seen: number[] = [];
    clock.schedule(7, () => seen.push(clock.now));
    clock.schedule(19, () => seen.push(clock.now));

    clock.runFor(50);

    expect(seen).toEqual([7, 19]);
    expect(clock.now).toBe(50);
  });

  it("repeats without drifting, and can be stopped", () => {
    const clock = new SimClock();
    const times: number[] = [];
    const stop = clock.every(1000 / 30, () => times.push(clock.now));

    // The 30th occurrence is due at 1000 ms, give or take rounding, so run a little past it.
    clock.runUntil(1010);
    stop();
    clock.runUntil(2000);

    expect(times).toHaveLength(30);
    expect(times[29]).toBeCloseTo(1000, 9);
  });

  it("runs an event scheduled by another event when it falls due", () => {
    const clock = new SimClock();
    const ran: number[] = [];
    clock.schedule(10, () => clock.schedule(clock.now + 5, () => ran.push(clock.now)));

    clock.runUntil(20);

    expect(ran).toEqual([15]);
  });
});

describe("createRandom", () => {
  it("repeats a seed and separates seeds and streams", () => {
    const draw = (seed: number) => Array.from({ length: 5 }, createRandom(seed));

    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    expect(deriveSeed(7, 0)).not.toBe(deriveSeed(7, 1));
    expect(deriveSeed(7, 1)).toBe(deriveSeed(7, 1));
  });

  it("draws uniformly from [0, 1)", () => {
    const random = createRandom(3);
    const draws = Array.from({ length: 10_000 }, random);

    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(draws.reduce((sum, value) => sum + value, 0) / draws.length).toBeCloseTo(0.5, 1);
  });
});

describe("LossyLink", () => {
  function link(conditions: Parameters<typeof symmetric>[0], seed = 1) {
    const clock = new SimClock();
    const arrivals: Array<{ at: number; value: number }> = [];
    const lossy = new LossyLink(clock, createRandom(seed), conditions, (data) => {
      arrivals.push({ at: clock.now, value: data[0] });
    });
    return { clock, lossy, arrivals };
  }

  it("delays every packet by the one-way latency", () => {
    const { clock, lossy, arrivals } = link({ oneWayMs: 100 });

    lossy.send(Uint8Array.of(1));
    clock.runFor(99);
    expect(arrivals).toEqual([]);
    clock.runFor(1);

    expect(arrivals).toEqual([{ at: 100, value: 1 }]);
  });

  it("drops about the configured share of packets", () => {
    const { clock, lossy, arrivals } = link({ loss: 0.05 });

    for (let i = 0; i < 20_000; i++) {
      lossy.send(Uint8Array.of(i & 0xff));
    }
    clock.runFor(1);

    expect(arrivals.length / 20_000).toBeCloseTo(0.95, 2);
    expect(lossy.stats).toMatchObject({ sent: 20_000, delivered: arrivals.length });
    expect(lossy.stats.lost).toBe(20_000 - arrivals.length);
  });

  it("lets later packets overtake a delayed one", () => {
    const { clock, lossy, arrivals } = link({ oneWayMs: 10, reorder: 1, reorderExtraMs: 200 });

    for (let i = 0; i < 50; i++) {
      clock.schedule(i * 5, () => lossy.send(Uint8Array.of(i)));
    }
    clock.runFor(1000);

    const order = arrivals.map((arrival) => arrival.value);
    expect(order).toHaveLength(50);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
  });

  it("delivers in order when nothing is reordered", () => {
    const { clock, lossy, arrivals } = link({ oneWayMs: 40 });

    for (let i = 0; i < 20; i++) {
      clock.schedule(i, () => lossy.send(Uint8Array.of(i)));
    }
    clock.runFor(1000);

    expect(arrivals.map((arrival) => arrival.value)).toEqual(
      Array.from({ length: 20 }, (_, i) => i)
    );
  });

  it("drops what is sent while blocked, and what is still in flight when it is blocked", () => {
    const { clock, lossy, arrivals } = link({ oneWayMs: 100 });

    lossy.send(Uint8Array.of(1));
    clock.runFor(50);
    lossy.blocked = true;
    lossy.send(Uint8Array.of(2));
    clock.runFor(200);
    lossy.blocked = false;
    lossy.send(Uint8Array.of(3));
    clock.runFor(200);

    expect(arrivals.map((arrival) => arrival.value)).toEqual([3]);
    expect(lossy.stats.blocked).toBe(2);
  });

  it("delivers a copy, so a sender that reuses its buffer cannot corrupt a packet in flight", () => {
    const { clock, lossy, arrivals } = link({ oneWayMs: 10 });
    const buffer = Uint8Array.of(1);

    lossy.send(buffer);
    buffer[0] = 9;
    clock.runFor(20);

    expect(arrivals.map((arrival) => arrival.value)).toEqual([1]);
  });
});

describe("ReplicationSim", () => {
  let sim: ReplicationSim | undefined;

  afterEach(() => {
    sim?.dispose();
    sim = undefined;
  });

  function runOnce(seed: number) {
    const simulation = new ReplicationSim({
      networkComponents: [Position],
      seed,
      link: symmetric({ oneWayMs: 60, loss: 0.1, reorder: 0.2, reorderExtraMs: 50 }),
    });
    sim = simulation;
    const entity = simulation.server.entity().add(Networked).set(Position, { x: 0, y: 0 });
    simulation.onTick((tick) => entity.set(Position, { x: tick, y: tick * 2 }));
    const client = simulation.addClient();
    simulation.run(5_000);
    const summary = {
      framesSent: client.stats.framesSent,
      baselines: client.stats.baselinesSent,
      resets: client.stats.resets,
      down: { ...client.down.stats },
      up: { ...client.up.stats },
    };
    simulation.dispose();
    sim = undefined;
    return summary;
  }

  it("reproduces a run exactly from its seed, and differs for another seed", () => {
    const first = runOnce(5);

    expect(runOnce(5)).toEqual(first);
    expect(runOnce(6)).not.toEqual(first);
  });

  it("drives the server on a 30 Hz virtual clock, whatever real time does", () => {
    sim = new ReplicationSim({ networkComponents: [Position] });

    sim.run(1_010);

    expect(sim.ticks).toBe(30);
    expect(sim.clock.now).toBe(1_010);
  });

  it("records a client's disconnect, which is how a client that rejected the server shows up", () => {
    sim = new ReplicationSim({ networkComponents: [Position] });
    const client = sim.addClient();
    expect(client.stats.disconnects).toEqual([]);

    client.world.close();

    expect(client.stats.disconnects).toEqual([{ atMs: 0, code: undefined, reason: undefined }]);
  });

  it("tells a client apart from the server when their states differ", () => {
    sim = new ReplicationSim({
      networkComponents: [Position],
      link: symmetric({ oneWayMs: 50 }),
    });
    const entity = sim.server.entity().add(Networked).set(Position, { x: 1, y: 1 });
    const client = sim.addClient();

    expect(sim.diffFromServer(client)).toEqual([
      `entity ${entity.eid} is missing on the client (server has Position{"x":1,"y":1})`,
    ]);

    sim.run(1_000);
    expect(sim.diffFromServer(client)).toEqual([]);

    entity.set(Position, { x: 2, y: 2 });
    expect(sim.diffFromServer(client)).toEqual([
      `entity ${entity.eid}: client has Position{"x":1,"y":1}, server has Position{"x":2,"y":2}`,
    ]);
  });
});
