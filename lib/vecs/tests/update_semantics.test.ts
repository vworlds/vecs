import { describe, expect, it, vi } from "vitest";
import { World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
  vy = 0;
}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  return { w };
}

describe("update semantics", () => {
  it("case 1: add(C) — update fires via enter backfill (entity enters query, same tick)", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const cb = vi.fn();
    w.system("sys").phase(phase).requires(Position).update(Position, cb);
    w.start();
    w.progress(0, 0);

    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    // update fires — not from the direct channel, but from _enter backfill
    // (entity first matches query → _enter iterates watchlist components →
    // _notifyModified called for Position)
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("case 2: set(C, props) first time — update fires via enter backfill (same tick)", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const cb = vi.fn();
    w.system("sys").phase(phase).requires(Position).update(Position, cb);
    w.start();
    w.progress(0, 0);

    const e = w.entity();
    const pos = e.set(Position, { x: 1, y: 2 }).get(Position)!;
    w.progress(0, 0);
    // update fires: entity enters query → _enter backfill notifies Position
    expect(cb).toHaveBeenCalledWith(e, pos);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("case 3: set(C, props) after entity already in query — direct update, same tick", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const cb = vi.fn();
    w.system("sys").phase(phase).requires(Position).update(Position, cb);
    w.start();
    const e = w.entity();
    const pos = e.set(Position, { x: 0, y: 0 }).get(Position)!;
    w.progress(0, 0); // enter + backfill
    cb.mockClear();

    e.set(Position, { x: 10, y: 20 });
    w.progress(0, 0);
    // direct update: component already existed → isUpdate=true → _notifyComponentChanged
    expect(cb).toHaveBeenCalledWith(e, pos);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("case 4: modified(C) — always direct update (isUpdate=true forced)", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const cb = vi.fn();
    w.system("sys").phase(phase).requires(Position).update(Position, cb);
    w.start();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // enter + backfill
    cb.mockClear();

    e.modified(Position);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, pos);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("case 5: enter backfill notifies ALL watchlist components, not just the added one", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const posCb = vi.fn();
    const velCb = vi.fn();
    w.system("sys")
      .phase(phase)
      .requires(Position, Velocity)
      .update(Position, posCb)
      .update(Velocity, velCb);
    w.start();
    w.progress(0, 0);

    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    // Entity enters when second component is added (now matches requires)
    w.progress(0, 0);
    // Both Position and Velocity update callbacks fire via enter backfill
    expect(posCb).toHaveBeenCalledWith(e, pos);
    expect(velCb).toHaveBeenCalledWith(e, vel);
  });

  it("case 6: second set on one component only fires that component's update", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const posCb = vi.fn();
    const velCb = vi.fn();
    w.system("sys")
      .phase(phase)
      .requires(Position, Velocity)
      .update(Position, posCb)
      .update(Velocity, velCb);
    w.start();
    const e = w.entity();
    const pos = e.set(Position, { x: 0, y: 0 }).get(Position)!;
    e.add(Velocity);
    w.progress(0, 0);
    posCb.mockClear();
    velCb.mockClear();

    e.set(Position, { x: 99, y: 99 });
    w.progress(0, 0);
    // Direct update: only Position's callback fires
    expect(posCb).toHaveBeenCalledWith(e, pos);
    expect(posCb).toHaveBeenCalledTimes(1);
    expect(velCb).not.toHaveBeenCalled();
  });

  it("case 7: remove → re-set re-enters query, enter backfill fires update", () => {
    const { w } = setup();
    const phase = w.addPhase("main");
    const cb = vi.fn();
    w.system("sys").phase(phase).requires(Position).update(Position, cb);
    w.start();
    const e = w.entity();
    e.set(Position, { x: 1, y: 2 });
    w.progress(0, 0); // enter + backfill
    e.remove(Position);
    w.progress(0, 0); // exit
    cb.mockClear();

    const pos = e.set(Position, { x: 99, y: 99 }).get(Position)!;
    w.progress(0, 0);
    // Re-enters query → enter backfill fires update (same tick, not direct channel)
    expect(cb).toHaveBeenCalledWith(e, pos);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
