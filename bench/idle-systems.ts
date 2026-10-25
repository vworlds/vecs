/** Price a whole idle frame, including pipeline and empty flush overhead. */
import { World } from "@vworlds/vecs";

class Value {
  n = 0;
}

const systems = positiveInteger("BENCH_SYSTEMS", 100);
const ticks = positiveInteger("BENCH_TICKS", 108_000);
const warmup = positiveInteger("BENCH_WARMUP_TICKS", 10_000);
const delta = 1000 / 30;
const results = [];
for (const kind of ["reactive", "each", "run"] as const) {
  const world = new World();
  world.component(Value);
  let callbacks = 0;
  let checksum = 0;
  const record = (index: number): void => {
    callbacks++;
    checksum = (checksum + index + 1) >>> 0;
  };
  for (let index = 0; index < systems; index++) {
    const system = world.system(`idle-${kind}-${index}`).with(Value);
    if (kind === "reactive") {
      system
        .enter(() => record(index))
        .update(Value, () => record(index))
        .exit(() => record(index));
    } else if (kind === "each") {
      system.each([Value], () => record(index));
    } else {
      system.run(() => record(index));
    }
  }
  // Reactive queries keep a member, but have no new events after warmup.
  if (kind === "reactive") {
    world.entity().add(Value);
  }
  for (let frame = 1; frame <= warmup; frame++) {
    world.progress(frame * delta, delta);
  }
  callbacks = 0;
  checksum = 0;
  const start = performance.now();
  for (let frame = 1; frame <= ticks; frame++) {
    world.progress((warmup + frame) * delta, delta);
  }
  const frameMs = (performance.now() - start) / ticks;
  const expected = kind === "run" ? systems * ticks : 0;
  const expectedChecksum = kind === "run" ? ((ticks * systems * (systems + 1)) / 2) >>> 0 : 0;
  if (callbacks !== expected || checksum !== expectedChecksum) {
    throw new Error(`${kind}: unexpected callback fingerprint ${callbacks}/${checksum}`);
  }
  results.push({ kind, frameMs, nsPerSystem: (frameMs * 1e6) / systems, callbacks, checksum });
  world.dispose();
}
console.log(`IDLE_RESULT ${JSON.stringify({ config: { systems, ticks, warmup }, results })}`);

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
