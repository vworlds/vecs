import { describe, it, expect, vi } from "vitest";
import { Entity, Query, SilenceSource, World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
  vy = 0;
}
/** Marker attached to system entities to group them into a silence domain. */
class Physics {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Physics);
  const phase = w.addPhase("p");
  return { w, phase };
}

describe("System.ignoreSource — silencing feedback loops", () => {
  it("silences a system's own writeback", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    const damp = w
      .system("Damp")
      .phase(phase)
      .requires(Position)
      .ignoreSource([Physics])
      .update(Position, (e) => {
        cb();
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    damp.entity.add(Physics); // include self in the silenced domain
    w.start();

    const e = w.entity().add(Position);
    w.progress(0, 0); // entry initializes; the writeback is silenced
    expect(cb).toHaveBeenCalledTimes(1);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1); // no external change -> no re-fire

    e.getMut(Position, (p) => {
      p.x = 100;
    }); // external write (no source)
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("without silencing, a self-writeback re-fires every frame", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("Damp")
      .phase(phase)
      .requires(Position)
      .update(Position, (e) => {
        cb();
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    w.start();

    w.entity().add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("silences a later writeback system but still reacts to external writes", () => {
    const { w, phase } = setup();
    const readCb = vi.fn();
    w.system("Read")
      .phase(phase)
      .requires(Position)
      .ignoreSource([Physics])
      .update(Position, () => readCb());
    const write = w
      .system("Write")
      .phase(phase)
      .requires(Position)
      .each([Position], (e) => {
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    write.entity.add(Physics);
    w.start();

    const e = w.entity().add(Position);
    w.progress(0, 0); // entry initializes Read
    const afterEntry = readCb.mock.calls.length;
    w.progress(0, 0);
    w.progress(0, 0); // Write writes every frame, silenced for Read
    expect(readCb.mock.calls.length).toBe(afterEntry);

    e.getMut(Position, (p) => {
      p.x = 50;
    }); // external write
    w.progress(0, 0);
    expect(readCb.mock.calls.length).toBe(afterEntry + 1);
  });

  it("updates from sources outside the domain still wake the system", () => {
    const { w, phase } = setup();
    const readCb = vi.fn();
    w.system("Read")
      .phase(phase)
      .requires(Position)
      .ignoreSource([Physics])
      .update(Position, () => readCb());
    // Not tagged Physics -> outside the silenced domain.
    w.system("Other")
      .phase(phase)
      .requires(Position)
      .each([Position], (e) => {
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    w.start();

    w.entity().add(Position);
    w.progress(0, 0); // entry (one call) + Other writes
    w.progress(0, 0);
    w.progress(0, 0);
    expect(readCb.mock.calls.length).toBeGreaterThan(1); // woken by Other beyond entry
  });

  it("does not silence entry-time initialization from an ignored source", () => {
    const { w, phase } = setup();
    const readCb = vi.fn();
    let created: Entity | undefined;
    // Writer is in the silenced domain and introduces a matching entity.
    const writer = w
      .system("Writer")
      .phase(phase)
      .run(() => {
        if (!created) {
          created = w.entity().add(Position);
        }
      });
    writer.entity.add(Physics);
    w.system("Read")
      .phase(phase)
      .requires(Position)
      .ignoreSource([Physics])
      .update(Position, (e) => readCb(e));
    w.start();

    w.progress(0, 0); // Writer (sourced) adds Position; Read enters and initializes
    expect(readCb).toHaveBeenCalled();
    expect(readCb.mock.calls[0][0]).toBe(created);
  });

  it("destroys the inline silence query with the system", () => {
    const { w, phase } = setup();
    const read = w
      .system("Read")
      .phase(phase)
      .requires(Position)
      .ignoreSource([Physics])
      .update(Position, () => {});
    w.start();

    const silenceEntity = read.entity.get(SilenceSource)!.target;
    const silenceQuery = silenceEntity.get(Query)!;
    expect(w.queries).toContain(silenceQuery);

    read.destroy();
    expect(w.queries).not.toContain(silenceQuery);
  });
});
