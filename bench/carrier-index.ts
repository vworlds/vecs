/** Measure carrier insertion/removal and retained heap against built packages. */
import assert from "node:assert/strict";
import { World } from "@vworlds/vecs";

const count = 10_000;
const rounds = 100;
const warmup = 20;
const components = Array.from(
  { length: 8 },
  () =>
    class Data {
      value = 1;
    }
);
const median = (samples: number[]): number => samples.sort((a, b) => a - b)[samples.length / 2];

if (!global.gc) {
  throw new Error("Run with --expose-gc to measure retained heap");
}
for (const queried of [false, true]) {
  const world = new World();
  const component = components[0];
  const meta = world.component(component).meta;
  const query = queried ? world.query("data").with(component).build() : undefined;
  const entities = Array.from({ length: count }, () => world.entity());
  const adds: number[] = [];
  const pairs: number[] = [];
  for (let round = -warmup; round < rounds; round++) {
    const start = process.hrtime.bigint();
    for (const entity of entities) {
      entity.add(component);
    }
    const added = process.hrtime.bigint();
    assert.equal(meta.usageCount, count);
    if (query) {
      assert.equal(query.count, count);
    }
    const removeStart = process.hrtime.bigint();
    for (const entity of entities) {
      entity.remove(component);
    }
    const removed = process.hrtime.bigint();
    assert.equal(meta.usageCount, 0);
    if (query) {
      assert.equal(query.count, 0);
    }
    if (round >= 0) {
      adds.push(Number(added - start) / count);
      pairs.push(Number(added - start + removed - removeStart) / (count * 2));
    }
  }
  world.dispose();

  global.gc();
  const before = process.memoryUsage().heapUsed;
  const scene = new World();
  for (let i = 0; i < components.length; i++) {
    scene.component(components[i]);
    if (queried) {
      scene.query(`component-${i}`).with(components[i]).build();
    }
  }
  for (let i = 0; i < count; i++) {
    const entity = scene.entity();
    for (const Class of components) {
      entity.add(Class);
    }
  }
  global.gc();
  const heapBytes = process.memoryUsage().heapUsed - before;
  for (const Class of components) {
    assert.equal(scene.component(Class).meta.usageCount, count);
  }
  console.log(
    `CARRIER_INDEX ${JSON.stringify({ queried, count, rounds, warmup, addNs: median(adds), operationNs: median(pairs), heapBytes })}`
  );
  scene.dispose();
}
