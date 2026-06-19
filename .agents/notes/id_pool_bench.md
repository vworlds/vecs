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

## Variant 3: 2-level (L1 + L2) hierarchical bitmap

Adds an L2 summary word per 32 L1 words tracking "this L1 word has a free
slot". The goal was to make the alloc word-walk O(1) instead of O(walks)
on workloads where the cursor `_minFreeWord` is pulled to word 0 by a
random low free (e.g. steady-churn).

Hypothesis did not pan out at the benchmark sizes (5k ids → 2-5 L2 words):
the L2 bookkeeping on every alloc/free roughly cancels the savings on the
L1 walk, while adding cost on the simple seq-alloc path. Results are at
parity or slightly worse than v2. Larger pools (≥ 32k ids) would shift
this; for the current ECS scale, the flat bitmap (v2) wins.

| scenario                      | run1 | run2 | run3 |
| ----------------------------- | ---- | ---- | ---- |
| seq-alloc-5k                  | 0.18 | 0.48 | 0.28 |
| alloc-freeAll-allocAgain-5k   | 0.48 | 0.57 | 0.53 |
| alloc-freeHighTail-alloc-10k  | 0.47 | 0.51 | 0.47 |
| alloc-freeRandomHalf-alloc-5k | 0.76 | 0.80 | 0.77 |
| alloc-freeEveryOther-alloc-5k | 0.18 | 0.41 | 0.37 |
| steady-churn-2k-10kops        | 1.37 | 1.35 | 1.46 |
| reserve-sparse-then-alloc-5k  | 0.97 | 1.00 | 1.19 |

## Variant 4: v2 with proactive cursor bump in alloc

Reverts the L2 layer; reinstates v2's flat bitmap but also bumps the
`_minFreeWord` cursor to `word + 1` when alloc fills the last 0 bit of
the current word (`nw === -1`). On the next alloc the walk over full
words starts past the just-filled one, which trims work from the random
churn path that always re-arrives at the same low cursor.

Modest, mostly within-noise improvements over v2 (~3-10%). Reserve-sparse
is the same.

| scenario                      | run1 | run2 | run3 |
| ----------------------------- | ---- | ---- | ---- |
| seq-alloc-5k                  | 0.15 | 0.15 | 0.15 |
| alloc-freeAll-allocAgain-5k   | 0.35 | 0.43 | 0.38 |
| alloc-freeHighTail-alloc-10k  | 0.42 | 0.42 | 0.45 |
| alloc-freeRandomHalf-alloc-5k | 0.63 | 0.63 | 0.78 |
| alloc-freeEveryOther-alloc-5k | 0.34 | 0.30 | 0.36 |
| steady-churn-2k-10kops        | 1.40 | 1.36 | 1.35 |
| reserve-sparse-then-alloc-5k  | 1.27 | 1.16 | 0.89 |

## Variant 5: v4 + single-slot "lowest free" cache

Adds a `_lowest` slot that free() updates only when the freed id is the
smallest free seen so far (or the first one freed). alloc() consumes the
slot before touching the bitmap. Targets the free → alloc churn pattern
(the steady-state ECS workload), where the just-freed id is also the
lowest free, so alloc skips the bitmap walk entirely.

Five-run set (medians per round): steady-churn 1.07-1.18 ms vs v4's 1.36

- a consistent ~15-20% drop. Other scenarios are within noise of v4.
  free-high-tail is bimodal (some runs cache-hit, some don't); a few
  slow runs land near v4's median, others land below.

| scenario                      | run1 | run2 | run3 | run4 | run5 |
| ----------------------------- | ---- | ---- | ---- | ---- | ---- |
| seq-alloc-5k                  | 0.16 | 0.15 | 0.17 | 0.15 | 0.16 |
| alloc-freeAll-allocAgain-5k   | 0.41 | 0.41 | 0.40 | 0.40 | 0.37 |
| alloc-freeHighTail-alloc-10k  | 0.46 | 0.45 | 0.41 | 1.38 | 1.40 |
| alloc-freeRandomHalf-alloc-5k | 0.81 | 0.64 | 0.66 | 0.72 | 0.67 |
| alloc-freeEveryOther-alloc-5k | 0.37 | 0.36 | 0.31 | 0.37 | 0.34 |
| steady-churn-2k-10kops        | 1.08 | 1.17 | 1.07 | 1.14 | 1.13 |
| reserve-sparse-then-alloc-5k  | 1.08 | 1.29 | 1.16 | 0.98 | 1.12 |
