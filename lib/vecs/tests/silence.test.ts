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
/** Marker attached to query entities to group them into a silence domain. */
class Physics {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Physics);
  return { w };
}

describe("Query.ignoreSource — silencing feedback loops", () => {
  it("on a system, silences its own writeback", () => {
    const { w } = setup();
    const cb = vi.fn();
    const damp = w
      .system("Damp")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, (e) => {
        cb();
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    damp.entity.add(Physics); // include self in the silenced domain

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
    const { w } = setup();
    const cb = vi.fn();
    w.system("Damp")
      .with(Position)
      .update(Position, (e) => {
        cb();
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });

    w.entity().add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("silences a later writeback system but still reacts to external writes", () => {
    const { w } = setup();
    const readCb = vi.fn();
    w.system("Read")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, () => readCb());
    const write = w
      .system("Write")
      .with(Position)
      .each([Position], (e) => {
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    write.entity.add(Physics);

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

  it("updates from sources outside the domain still wake the query", () => {
    const { w } = setup();
    const readCb = vi.fn();
    w.system("Read")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, () => readCb());
    // Not tagged Physics -> outside the silenced domain.
    w.system("Other")
      .with(Position)
      .each([Position], (e) => {
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });

    w.entity().add(Position);
    w.progress(0, 0); // entry (one call) + Other writes
    w.progress(0, 0);
    w.progress(0, 0);
    expect(readCb.mock.calls.length).toBeGreaterThan(1); // woken by Other beyond entry
  });

  it("does not silence entry-time initialization from an ignored source", () => {
    const { w } = setup();
    const readCb = vi.fn();
    let created: Entity | undefined;
    // Writer is in the silenced domain and introduces a matching entity.
    const writer = w.system("Writer").run(() => {
      if (!created) {
        created = w.entity().add(Position);
      }
    });
    writer.entity.add(Physics);
    w.system("Read")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, (e) => readCb(e));

    w.progress(0, 0); // Writer (sourced) adds Position; Read enters and initializes
    expect(readCb).toHaveBeenCalled();
    expect(readCb.mock.calls[0][0]).toBe(created);
  });

  it("destroys the inline silence query with the parent query", () => {
    const { w } = setup();
    const read = w
      .system("Read")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, () => {});

    const silenceEntity = read.entity.get(SilenceSource)!.target;
    const silenceQuery = silenceEntity.get(Query)!;
    read.build();
    silenceQuery.build();
    expect(w.queries).toContain(silenceQuery);

    read.destroy();
    expect(w.queries).not.toContain(silenceQuery);
  });

  it("silences update callbacks on a plain query", () => {
    const { w } = setup();
    const cb = vi.fn();
    const rq = w
      .query("ReadQ")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, () => cb());

    const writer = w.system("Writer").run(() => {
      const e = w.entity();
      e.add(Position);
      e.getMut(Position, (p) => {
        p.x = 1;
      });
    });
    writer.entity.add(Physics);

    // Write is silenced — the plain query's update callback must not fire.
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();

    // External mutation (unsourced) must fire.
    const ext = w.entity().add(Position);
    ext.getMut(Position, (p) => {
      p.x = 99;
    });
    w.flush();
    expect(cb).toHaveBeenCalled();
  });

  it("destroys the inline silence query with the plain query", () => {
    const { w } = setup();
    const rq = w
      .query("ReadQ")
      .with(Position)
      .ignoreSource([Physics])
      .update(Position, () => {});

    const silenceEntity = rq.entity.get(SilenceSource)!.target;
    const silenceQuery = silenceEntity.get(Query)!;
    rq.build();
    silenceQuery.build();
    expect(w.queries).toContain(silenceQuery);

    rq.destroy();
    expect(w.queries).not.toContain(silenceQuery);
  });

  it("accepts an existing query as the silence domain", () => {
    const { w } = setup();
    const domain = w.query("Domain").with(Physics);

    const cb = vi.fn();
    w.system("Read")
      .with(Position)
      .ignoreSource(domain)
      .update(Position, () => cb());

    const writer = w
      .system("Writer")
      .with(Position)
      .each([Position], (e) => {
        e.getMut(Position, (p) => {
          p.x += 1;
        });
      });
    writer.entity.add(Physics);

    const e = w.entity().add(Position);
    w.progress(0, 0); // entry bridge
    const afterEntry = cb.mock.calls.length;
    w.progress(0, 0); // Writer writes, silenced
    expect(cb).toHaveBeenCalledTimes(afterEntry);

    e.getMut(Position, (p) => {
      p.x = 42;
    }); // external write
    w.progress(0, 0);
    expect(cb.mock.calls.length).toBeGreaterThan(afterEntry);
  });
});
