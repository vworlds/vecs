/** Compare dynamic key membership, static unions and the existing diamond refresh path. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { World, type QueryDSL } from "@vworlds/vecs";

class Trait {}
class X {}
class Extra {}

const keys = Number(process.env.BENCH_KEYS ?? 16);
const writes = Number(process.env.BENCH_WRITES ?? 200_000);
const warmup = Number(process.env.BENCH_WARMUP_WRITES ?? 20_000);
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
for (const n of [keys, writes, warmup, rounds]) {
  assert(Number.isSafeInteger(n) && n > 0);
}
const diamondOnly = process.argv.includes("diamond");

for (let round = 1; round <= rounds; round++) {
  const variants = diamondOnly
    ? ["diamond"]
    : ["static", "dynamic", "static-sibling", "dynamic-sibling", "diamond"];
  if (round % 2 === 0) {
    variants.reverse();
  }
  for (const variant of variants) {
    for (const deferred of [false, true]) {
      for (const operation of variant.includes("sibling") || variant === "diamond"
        ? ["update"]
        : ["enter", "exit", "update"]) {
        const w = new World();
        w.component(Trait);
        w.component(X);
        w.component(Extra);
        const components = Array.from({ length: keys }, () => class Key {});
        components.forEach((c) => w.component(c).add(Trait));
        const union: QueryDSL = variant.startsWith("dynamic")
          ? { anyOf: Trait }
          : { any: components };
        const dsl: QueryDSL =
          variant === "diamond"
            ? { any: [X, { all: [X, Extra] }] }
            : variant.includes("sibling")
              ? { all: [X, union] }
              : union;
        const term = w.getTerm(dsl);
        let enters = 0;
        let exits = 0;
        const unsubscribe = term.subscribe({
          onTermEvent: (kind) => {
            if (kind === 0) {
              enters++;
            } else {
              exits++;
            }
          },
        });
        const entities = Array.from({ length: 100 }, (_, i) => {
          const e = w.entity().add(X);
          if (operation === "update") {
            e.add(components[i % keys]);
          }
          return e;
        });
        const updateX = variant.includes("sibling") || variant === "diamond";
        const updateComponents = entities.map((_, i) => (updateX ? X : components[i % keys]));
        const mutate = (fn: () => void) => {
          if (deferred) {
            w.defer(fn);
          } else {
            fn();
          }
        };
        function run(count: number): number {
          let elapsed = 0;
          for (let offset = 0; offset < count; offset += 100) {
            const batch = Math.min(100, count - offset);
            if (operation === "exit") {
              mutate(() => {
                for (let i = 0; i < batch; i++) {
                  entities[i].add(components[i % keys]);
                }
              });
            }
            const start = performance.now();
            mutate(() => {
              for (let i = 0; i < batch; i++) {
                const e = entities[i];
                const c = components[i % keys];
                if (operation === "enter") {
                  e.add(c);
                } else if (operation === "exit") {
                  e.remove(c);
                } else {
                  e.modified(updateComponents[i]);
                }
              }
            });
            elapsed += performance.now() - start;
            if (operation === "enter") {
              mutate(() => {
                for (let i = 0; i < batch; i++) {
                  entities[i].remove(components[i % keys]);
                }
              });
            }
          }
          return (elapsed * 1e6) / count;
        }
        run(warmup);
        enters = exits = 0;
        const nsPerWrite = run(writes);
        assert.equal(enters, operation === "update" ? 0 : writes);
        assert.equal(exits, operation === "update" ? 0 : writes);
        console.log(
          "ANYOF_RESULT " +
            JSON.stringify({
              round,
              variant,
              operation,
              deferred,
              keys,
              writes,
              nsPerWrite,
              enters,
              exits,
            })
        );
        unsubscribe();
        w.dispose();
      }
    }
  }
}
