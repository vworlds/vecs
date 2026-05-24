# IdPool benchmark results

Captured with `RUN_ID_POOL_BENCH=1 npx vitest run tests/id_pool.bench.test.ts`
on the cloud env. Median of 5 rounds per scenario, after one warm-up.

Numbers are median ms per round (lower is better). Each variant snapshot
shows three independent runs to gauge noise.

## Variant 0: baseline (Set + linear scan from min)

| scenario                      | run1   | run2   | run3   |
| ----------------------------- | ------ | ------ | ------ |
| seq-alloc-5k                  | 112.86 | 110.86 | 117.54 |
| alloc-freeAll-allocAgain-5k   | 229.17 | 233.88 | 247.39 |
| alloc-freeHighTail-alloc-10k  | 781.63 | 772.25 | 786.80 |
| alloc-freeRandomHalf-alloc-5k | 181.24 | 182.90 | 185.74 |
| alloc-freeEveryOther-alloc-5k | 174.26 | 175.60 | 179.47 |
| steady-churn-2k-10kops        | 80.55  | 81.74  | 81.72  |
| reserve-sparse-then-alloc-5k  | 1.96   | 2.01   | 1.98   |
