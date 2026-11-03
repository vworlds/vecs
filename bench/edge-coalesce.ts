/** Price add/remove-edge routing, including deferred drain and watcher delivery. */
import { performance } from "node:perf_hooks";
import { Exclusive, Relationship, World } from "@vworlds/vecs";

class Link extends Relationship {}

const drains = Number(process.env.BENCH_DRAINS ?? 1_000_000);
const warmup = Number(process.env.BENCH_WARMUP_DRAINS ?? 100_000);
if (![drains, warmup].every((n) => Number.isSafeInteger(n) && n > 0)) {
  throw new Error("BENCH_DRAINS and BENCH_WARMUP_DRAINS must be positive integers");
}

for (const mode of ["immediate", "deferred", "exclusive"] as const) {
  const world = new World();
  const rel = world.component(Link);
  if (mode === "exclusive") {
    rel.add(Exclusive);
  }
  const a = world.entity();
  const b = world.entity();
  const source = world.entity().add(Link, a);
  let updates = 0;
  let adds = 0;
  let removes = 0;
  rel.on("targetAdd", () => adds++).on("targetRemove", () => removes++);
  world
    .query("watcher")
    .with(Link)
    .update({ watch: Link }, () => updates++)
    .build();
  const change = () => {
    source.add(Link, b);
    if (mode === "exclusive") {
      source.add(Link, a);
    } else {
      source.remove(Link, b);
    }
  };
  const step = mode === "immediate" ? change : () => world.defer(change);
  for (let i = 0; i < warmup; i++) {
    step();
  }
  updates = adds = removes = 0;
  const start = performance.now();
  for (let i = 0; i < drains; i++) {
    step();
  }
  const nsPerDrain = ((performance.now() - start) * 1e6) / drains;
  const edgesPerDrain = mode === "exclusive" ? 4 : 2;
  if (
    adds + removes !== drains * edgesPerDrain ||
    source.target(Link) !== a ||
    source.hasTarget(Link, b)
  ) {
    throw new Error(`Incorrect edge transitions in ${mode}`);
  }
  if (
    (mode === "immediate" && updates !== drains * 2) ||
    (updates !== drains && updates !== drains * 2)
  ) {
    throw new Error(`Incorrect update count in ${mode}: ${updates}`);
  }
  console.log(
    `EDGE_RESULT ${JSON.stringify({ mode, drains, warmup, nsPerDrain, updates, adds, removes })}`
  );
  world.dispose();
}
