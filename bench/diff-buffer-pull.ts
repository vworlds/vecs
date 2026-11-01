/** Price interpolation plus the consumer's single snapshots read against built packages. */
import { performance } from "node:perf_hooks";
import { ComponentSnapshot, Diff, DiffBuffer, interpolatePosition } from "@vworlds/vecs-client";

const interval = 1000 / 30;
const warmup = 200;
const pulls = 1000;

function measure(count: number): number {
  const buffer = new DiffBuffer(3, interval, undefined, [[1, interpolatePosition]]);
  let frame = 0;
  let checksum = 0;
  function push(): void {
    const diff = new Diff(frame, frame + 1);
    frame++;
    for (let eid = 1; eid <= count; eid++) {
      diff.upsertSnapshot(new ComponentSnapshot(eid, 1, { x: frame, y: eid }));
    }
    buffer.push(diff);
  }
  push();
  push();
  let elapsed = 0;
  for (let i = 0; i < warmup + pulls; i++) {
    if (i % 2 === 0) {
      push();
    }
    const start = performance.now();
    const diff = buffer.pull(1000 + (i * interval) / 2);
    const snapshots = diff.snapshots;
    if (i >= warmup) {
      elapsed += performance.now() - start;
    }
    checksum += snapshots.length;
    const first = snapshots[0]?.payload as { x: number; y: number } | undefined;
    if (!first || Math.abs(first.x - buffer.renderFrame) > 1e-7 || first.y !== 1) {
      throw new Error(`Unexpected interpolated position at pull ${i}`);
    }
  }
  if (checksum !== (warmup + pulls) * count) {
    throw new Error(`Unexpected snapshot count: ${checksum}`);
  }
  return (elapsed * 1000) / pulls;
}

console.log("| Interpolated snapshots per frame | Time per pull (µs) | Per snapshot (µs) |");
console.log("| --- | --- | --- |");
for (const count of [100, 500, 1000, 2000, 4000]) {
  const microseconds = measure(count);
  console.log(`| ${count} | ${microseconds.toFixed(2)} | ${(microseconds / count).toFixed(3)} |`);
}
