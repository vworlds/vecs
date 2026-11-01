/** Measure removal routing against built packages; setup/addition is outside removal timing. */
import { World } from "@vworlds/vecs";

class A {
  value = 1;
}
class B {
  value = 2;
}

const count = 10_000;
const rounds = 100;
for (const scenario of ["no-query", "predicate", "exclusive"] as const) {
  const world = new World();
  world.component(A);
  world.component(B);
  if (scenario === "predicate") {
    world
      .query("predicate")
      .with({ test: (e) => !!e.get(A), watch: [A] })
      .build();
  }
  if (scenario === "exclusive") {
    world.setExclusiveComponents(A, B);
  }
  const entities = Array.from({ length: count }, () => world.entity());
  const samples: number[] = [];
  for (let round = -20; round < rounds; round++) {
    for (const entity of entities) {
      entity.add(A);
    }
    const start = process.hrtime.bigint();
    if (scenario === "exclusive") {
      for (const entity of entities) {
        entity.add(B);
      }
    } else {
      for (const entity of entities) {
        entity.remove(A);
      }
    }
    const ns = Number(process.hrtime.bigint() - start) / count;
    if (round >= 0) {
      samples.push(ns);
    }
  }
  samples.sort((a, b) => a - b);
  if (entities.some((entity) => entity.has(A))) {
    throw new Error("Removal did not clear A");
  }
  console.log(
    `REMOVE_NOTIFY ${JSON.stringify({ scenario, medianNs: samples[rounds / 2], count, rounds })}`
  );
  world.dispose();
}
