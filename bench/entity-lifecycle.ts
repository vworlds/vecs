/** Fresh-world two-component creation and destruction, measured separately. */
import assert from "node:assert/strict";
import { World, type Entity } from "@vworlds/vecs";

class Pos {
  x = 0;
  y = 0;
}
class Vel {
  x = 1;
  y = 1;
}

for (const count of [10_000, 100_000]) {
  const create: number[] = [];
  const destroy: number[] = [];
  for (let round = -2; round < 5; round++) {
    const world = new World();
    const pos = world.component(Pos);
    const vel = world.component(Vel);
    const all = new Array<Entity>(count);
    const before = performance.now();
    for (let i = 0; i < count; i++) {
      all[i] = world.entity().add(Pos).add(Vel);
    }
    const created = performance.now();
    assert.equal(pos.instanceCount(), count);
    assert.equal(vel.instanceCount(), count);
    const removing = performance.now();
    for (const entity of all) {
      entity.destroy();
    }
    const removed = performance.now();
    assert.equal(pos.instanceCount(), 0);
    assert.equal(vel.instanceCount(), 0);
    assert(all.every((entity) => !entity.alive));
    if (round >= 0) {
      create.push(((created - before) * 1e6) / count);
      destroy.push(((removed - removing) * 1e6) / count);
    }
    world.dispose();
  }
  console.log(
    `ENTITY_LIFECYCLE_RESULT ${JSON.stringify({ count, create: summary(create), destroy: summary(destroy), checksum: `created:${count};destroyed:${count}` })}`
  );
}

function summary(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return { median: sorted[2]!, min: sorted[0]!, max: sorted[4]! };
}
