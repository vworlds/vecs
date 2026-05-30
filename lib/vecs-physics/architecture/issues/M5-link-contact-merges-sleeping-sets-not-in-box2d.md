# M5 `linkContact` merges sleeping solver sets — divergence from box2d, comment misattributes the behavior

## What is wrong

`engine/island.ts::linkContact` handles the "both bodies sleeping" case by
calling `state._mergeSolverSets(state, setA, setB)`. The in-code comment
attributes this to `island.c:214-217` and says "if both sleeping → merge the
two sets" — but the cited lines in box2d do NOT do a set merge, they only
wake one body, and `b2MergeSolverSets` is **never** called from
`b2LinkContact` in box2d.

```ts
// src/engine/island.ts:297-315
if (setA >= _FIRST_SLEEPING_SET || setB >= _FIRST_SLEEPING_SET) {
  // island.c:207-217: wake sleeping bodies when a contact begins.
  // ...
  // island.c:214-217: if both sleeping → merge the two sets.
  if (setA >= _FIRST_SLEEPING_SET && setB >= _FIRST_SLEEPING_SET) {
    state._mergeSolverSets(state, setA, setB);
  } else if (setA >= _FIRST_SLEEPING_SET) {
    state._wakeSolverSet(state, setA);
  } else {
    state._wakeSolverSet(state, setB);
  }
}
```

The vendored box2d (`box2d/src/island.c:194-232`) is:

```c
// Wake bodyB if bodyA is awake and bodyB is sleeping
if (bodyA->setIndex == b2_awakeSet && bodyB->setIndex >= b2_firstSleepingSet)
    b2WakeSolverSet(world, bodyB->setIndex);
// Wake bodyA if bodyB is awake and bodyA is sleeping
if (bodyB->setIndex == b2_awakeSet && bodyA->setIndex >= b2_firstSleepingSet)
    b2WakeSolverSet(world, bodyA->setIndex);
```

`b2MergeSolverSets` is only invoked from `joint.c:326` (joint creation
across two sleeping bodies). No joints → it is dead code in v1.

## Why it is wrong

Two distinct problems sit on the same lines:

1. **Documentation parity bug.** The comment `island.c:214-217: if both
   sleeping → merge the two sets` is false. The named box2d lines are the
   second `b2WakeSolverSet` call, not a merge. A future agent reading the
   comment will trust the parity claim and either propagate the false
   mapping or revert the merge to match the cited box2d, breaking the
   actual semantics described below.

2. **Real semantic divergence.** vecs-physics adds a `mergeSolverSets`
   that box2d never performs. The intent is plausible (keep the invariant
   "all bodies in one island live in the same solver set" after the
   following `mergeIslands` call), but it should not be smuggled in under
   a parity comment. Either:
     - we match box2d (skip the merge, accept that an island can span
       two sleeping sets — box2d does, apparently without ill effect), or
     - we keep the merge as an intentional vecs-physics correctness
       choice, but record it explicitly in PLAN.md → _Settled Decisions_
       and rewrite the comment.

## Reproducing the divergence

The both-sleeping branch is hard to reach from the public API:
`updatePairs` only fires for proxies that have moved, and a sleeping body
does not move. The realistic path is the "ghost contact" — a non-touching
contact (in the awake set's `contactSims` while one body was awake) that
becomes touching on the same step the awake body falls asleep. To force
it from a test, manually transfer two bodies into different sleeping sets
(`wakeSolverSet` round-trip + `trySleepIsland` separately) and call
`linkContact` on a contact between them. With box2d's behavior the two
sleeping sets remain distinct; with the current vecs-physics behavior the
two sleeping sets are merged.

## Impacted code

- `src/engine/island.ts` lines 284-325 (`linkContact`).
- `src/engine/sleep.ts::mergeSolverSets` is correct in isolation; only
  its call site from `linkContact` is in question.

## Impacted features

- Sleep round-trips that involve a contact bridging two sleeping islands.
- Determinism vs. upstream box2d when such a contact arises.

## Possible solutions

- **A (match box2d, minimal):** Drop the `_mergeSolverSets` call. If
  `mergeIslands` then produces an island that spans two sets, accept that
  state (box2d does). Fix the comment to quote the actual `island.c` lines.
- **B (keep the merge, document it):** Keep the call, but rewrite the
  comment to say it is a vecs-physics correctness extension (not parity),
  cite the invariant being preserved, and record the decision in
  PLAN.md → _Settled Decisions_. Add a regression test that pins the
  resulting single-set / single-island state.

In either case the wrong `island.c:214-217` attribution must go.
