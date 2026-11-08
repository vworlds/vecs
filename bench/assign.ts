import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { World } from "@vworlds/vecs";

class FourFields {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
}

const writes = positive("BENCH_WRITES", 1_000_000);
const warmup = positive("BENCH_WARMUP_WRITES", 100_000);
const onlySet = process.argv[2] === "set";
const onlyMixed = process.argv[2] === "mixed";
assert(
  process.argv[2] === undefined || onlySet || onlyMixed,
  "expected optional 'set' or 'mixed' mode"
);

for (const deferred of onlyMixed ? [] : [false, true]) {
  for (const method of onlySet ? (["set"] as const) : (["set", "assign"] as const)) {
    for (const different of [false, true]) {
      const world = new World();
      const definition = world.component(FourFields);
      const entity = world.entity().add(FourFields);
      let updates = 0;
      world
        .query("watch")
        .with(FourFields)
        .update({ watch: FourFields }, () => updates++)
        .build();
      const values = [
        new FourFields(),
        Object.assign(new FourFields(), { a: 1, b: 2, c: 3, d: 4 }),
      ];
      const write =
        method === "set"
          ? (value: FourFields) => entity.set(definition.eid, value)
          : (value: FourFields) => entity.assign(definition.eid, value);
      // Reuse values so object creation does not swamp the write itself. Props
      // and instance candidates are measured independently below.
      for (const instance of [false, true]) {
        const candidates = instance ? values : values.map((value) => ({ ...value }));
        const run = (count: number) => {
          for (let start = 0; start < count; start += 100) {
            if (deferred) {
              world.beginDefer();
            }
            for (let i = start; i < Math.min(start + 100, count); i++) {
              write(candidates[different ? i % 2 : 0]!);
            }
            if (deferred) {
              world.endDefer();
            }
          }
        };
        run(warmup);
        const timings: number[] = [];
        for (let round = 0; round < 5; round++) {
          updates = 0;
          const start = performance.now();
          run(writes);
          timings.push(((performance.now() - start) * 1e6) / writes);
          const expected =
            method === "set"
              ? writes
              : different
                ? deferred
                  ? Math.ceil(writes / 100)
                  : writes
                : 0;
          assert.equal(updates, expected);
        }
        timings.sort((a, b) => a - b);
        console.log(
          "ASSIGN_RESULT",
          JSON.stringify({ method, deferred, different, instance, nsPerWrite: timings[2], updates })
        );
      }
    }
  }
}

if (!onlySet) {
  for (const instance of [false, true]) {
    for (const different of [false, true]) {
      const world = new World();
      const definition = world.component(FourFields);
      const setEntity = world.entity().add(FourFields);
      const assignEntity = world.entity().add(FourFields);
      let updates = 0;
      world
        .query("mixed.watch")
        .with(FourFields)
        .update({ watch: FourFields }, () => updates++)
        .build();
      const values = [
        new FourFields(),
        Object.assign(new FourFields(), { a: 1, b: 2, c: 3, d: 4 }),
      ];
      const candidates = instance ? values : values.map((value) => ({ ...value }));
      const run = (count: number, measureDrain: boolean) => {
        let drainMs = 0;
        for (let start = 0; start < count; start += 100) {
          world.beginDefer();
          for (let i = start; i < start + 100; i += 2) {
            const value = candidates[different ? (i / 2) % 2 : 0]!;
            setEntity.set(definition.eid, value);
            assignEntity.assign(definition.eid, value);
          }
          const startDrain = measureDrain ? performance.now() : 0;
          world.endDefer();
          if (measureDrain) {
            drainMs += performance.now() - startDrain;
          }
        }
        return (drainMs * 1e6) / count;
      };
      run(warmup, false);
      const timings: number[] = [];
      const drainTimings: number[] = [];
      for (let round = 0; round < 5; round++) {
        updates = 0;
        const start = performance.now();
        drainTimings.push(run(writes, true));
        timings.push(((performance.now() - start) * 1e6) / writes);
        assert.equal(updates, writes / 2 + (different ? writes / 100 : 0));
      }
      timings.sort((a, b) => a - b);
      drainTimings.sort((a, b) => a - b);
      console.log(
        "ASSIGN_RESULT",
        JSON.stringify({
          method: "mixed",
          deferred: true,
          different,
          instance,
          nsPerWrite: timings[2],
          drainNsPerWrite: drainTimings[2],
          updates,
        })
      );
    }
  }
}

function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert(
    Number.isSafeInteger(value) && value > 0 && value % 100 === 0,
    `${name} must be a positive multiple of 100`
  );
  return value;
}
