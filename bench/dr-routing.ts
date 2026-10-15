/** Isolate the excluded-watcher membership probe in Entity._routeModified, without physics or flushes. */
import { performance } from "node:perf_hooks";
import { World } from "@vworlds/vecs";

class Pose {
  x = 0;
}
class Other {}
class Moving {}

const writes = Number(process.env.BENCH_WRITES ?? 5_000_000);

function measure(excluded: boolean): number {
  const world = new World();
  world.component(Pose);
  world.component(Other);
  world.component(Moving);
  try {
    // Ensure the routing path walks the shorter watcher list (one excluded watcher vs eight
    // unrelated memberships). No callback runs or inbox event is allocated by the measured call.
    for (let i = 0; i < 8; i++) {
      world
        .system(`unrelated-${i}`)
        .with(Pose)
        .update(Other, () => {});
    }
    if (excluded) {
      world
        .system("excluded")
        .with(Pose)
        .without(Moving)
        .update(Pose, () => {
          throw new Error("moving entity must not receive a pose callback");
        });
    }
    const entity = world.entity().add(Pose).add(Other).add(Moving);
    world.progress(0, 0);
    const id = world.component(Pose).eid;
    const pose = entity.get(Pose)!;
    for (let i = 0; i < 100_000; i++) {
      entity._routeModified(id, pose);
    }
    const start = performance.now();
    for (let i = 0; i < writes; i++) {
      entity._routeModified(id, pose);
    }
    return ((performance.now() - start) * 1e6) / writes;
  } finally {
    world.dispose();
  }
}

const rounds = Array.from({ length: 9 }, (_, i) => {
  let plain: number;
  let excluded: number;
  if (i % 2 === 0) {
    plain = measure(false);
    excluded = measure(true);
  } else {
    excluded = measure(true);
    plain = measure(false);
  }
  return { plainNs: plain, excludedNs: excluded, addedNs: excluded - plain };
});
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;
console.log(
  `BENCH_RESULT ${JSON.stringify({
    writes,
    rounds,
    medianPlainNs: median(rounds.map((r) => r.plainNs)),
    medianExcludedNs: median(rounds.map((r) => r.excludedNs)),
    medianAddedNs: median(rounds.map((r) => r.addedNs)),
  })}`
);
