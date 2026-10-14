import assert from "node:assert/strict";
import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Chain,
  Circle,
  PhysicsModule,
  Position,
  preloadPhysics,
} from "../../src/index.js";
import { getFastPath } from "../../src/adapter/runtime.js";

await preloadPhysics();
const mode = process.argv[2];
if (mode === "capacity") {
  const worlds: World[] = [];
  const fast = getFastPath();
  const createExporter = fast.createMoveExporter.bind(fast);
  const exporters: ReturnType<typeof createExporter>[] = [];
  fast.createMoveExporter = (capacity) => {
    const exporter = createExporter(capacity);
    exporters.push(exporter);
    return exporter;
  };
  try {
    for (let i = 0; i < 128; i++) {
      const world = new World();
      worlds.push(world);
      world.module(PhysicsModule);
    }
    const refused = new World();
    worlds.push(refused);
    assert.throws(
      () => refused.module(PhysicsModule),
      /Box2D could not create.*128 live worlds per process/
    );
  } finally {
    for (const world of worlds) {
      world.dispose();
    }
    fast.createMoveExporter = createExporter;
  }
  assert.equal(exporters.length, 129);
  assert.ok(
    exporters.every((exporter) => exporter.ptr === 0),
    "including the refused world's buffer"
  );
  cycle(false);
} else {
  // Warm up the allocator before checking the high-water memory size; WASM memory cannot shrink.
  if (mode === "memory") {
    for (let i = 0; i < 20; i++) {
      cycle(true);
    }
  }
  const bytes = getFastPath().memory.buffer.byteLength;
  for (let i = 0; i < 300; i++) {
    cycle(mode !== "empty");
  }
  if (mode === "memory") {
    assert.equal(getFastPath().memory.buffer.byteLength, bytes);
  }
}
console.log(`PASS ${mode}`);

function cycle(populated: boolean): void {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 30, subSteps: 4 });
  if (populated) {
    const body = world.entity().set(Body, { type: BodyType.Static });
    world
      .entity()
      .childOf(body)
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        loop: true,
      });
    const moving = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 10, y: 10 });
    world.entity().childOf(moving).set(Circle, { radius: 0.25 });
  }
  world.progress(0, 1000 / 30);
  world.dispose();
}
