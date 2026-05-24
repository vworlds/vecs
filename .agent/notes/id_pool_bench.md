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

## Variant 1: Set + min-heap of freed + high-water mark

Algorithm: a binary min-heap holds freed ids; alloc pops the min (lazily
discarding entries already re-reserved). When the heap is empty, alloc
hands out the next never-used id (`_next`), skipping any ids that were
reserved out of band.

| scenario                      | run1 | run2 | run3 |
| ----------------------------- | ---- | ---- | ---- |
| seq-alloc-5k                  | 0.37 | 0.36 | 0.40 |
| alloc-freeAll-allocAgain-5k   | 1.51 | 1.74 | 1.61 |
| alloc-freeHighTail-alloc-10k  | 1.39 | 1.30 | 1.32 |
| alloc-freeRandomHalf-alloc-5k | 1.43 | 1.33 | 1.36 |
| alloc-freeEveryOther-alloc-5k | 0.96 | 1.00 | 0.99 |
| steady-churn-2k-10kops        | 2.29 | 2.07 | 2.30 |
| reserve-sparse-then-alloc-5k  | 1.26 | 1.19 | 1.29 |

Speedup over baseline (median of medians):

- seq-alloc: ~300x
- alloc-freeAll: ~150x
- alloc-freeHighTail: ~580x
- alloc-freeRandomHalf: ~130x
- alloc-freeEveryOther: ~175x
- steady-churn: ~37x
- reserve-sparse: ~1.5x

## Variant 2: occupancy bitmap + word cursor + freeBelowNext counter

Drops the Set and the heap. Reserved ids are stored as bits in a growable
plain-number array; alloc finds the lowest 0 bit at or above a `_minFreeWord`
cursor using `Math.clz32`-based ctz. A `_freeBelowNext` counter lets alloc
skip the bitmap walk entirely when there are no holes (pure fresh-id path).

| scenario                      | run1 | run2 | run3 |
| ----------------------------- | ---- | ---- | ---- |
| seq-alloc-5k                  | 0.22 | 0.16 | 0.17 |
| alloc-freeAll-allocAgain-5k   | 0.40 | 0.42 | 0.38 |
| alloc-freeHighTail-alloc-10k  | 0.50 | 0.41 | 0.43 |
| alloc-freeRandomHalf-alloc-5k | 0.65 | 0.64 | 0.34 |
| alloc-freeEveryOther-alloc-5k | 0.34 | 0.32 | 0.36 |
| steady-churn-2k-10kops        | 1.40 | 1.36 | 1.40 |
| reserve-sparse-then-alloc-5k  | 1.30 | 1.10 | 0.89 |
