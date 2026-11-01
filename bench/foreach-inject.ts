/** Price the per-call setup of injected `Query.forEach` against the bare form. */
import { World } from "@vworlds/vecs";

class A {
  n = 0;
}
class B {
  n = 0;
}

const calls = 2_000_000;
const world = new World();
world.component(A);
world.component(B);
world.entity().set(A, { n: 1 }).set(B, { n: 2 });
const query = world.query("foreach-inject").with(A, B).build();

let sum = 0;
const bare = (): void => {
  sum++;
};
const injected = (_e: unknown, [a, b]: readonly [A?, B?]): void => {
  sum += a!.n + b!.n;
};

function time(run: () => void): number {
  for (let i = 0; i < 200_000; i++) {
    run();
  }
  const start = process.hrtime.bigint();
  for (let i = 0; i < calls; i++) {
    run();
  }
  return Number(process.hrtime.bigint() - start) / calls;
}

const bareNs = time(() => query.forEach(bare));
const injectedNs = time(() => query.forEach([A, B], injected));
console.log(
  `FOREACH_INJECT bare=${bareNs.toFixed(1)}ns injected=${injectedNs.toFixed(1)}ns ratio=${(injectedNs / bareNs).toFixed(2)} checksum=${sum}`
);
