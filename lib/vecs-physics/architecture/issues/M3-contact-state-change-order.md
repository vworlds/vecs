# M3: Contact state changes are processed in gather order instead of contact-id order

## Summary

`collide()` tracks contacts whose touching state changed in a JavaScript `Set` and
then processes them in insertion order. Box2D records changed contacts in a bitset
indexed by contact id and processes them in ascending contact-id order. The current
ordering can diverge after contacts have moved between the awake-set and graph
arrays, which can change later contact-array ordering and therefore later solver
iteration order.

## What is wrong

The M3 progress note says the collide state-change loop mirrors Box2D and that the
serial pass is deterministic. It is deterministic for one run, but it is not the
same ordering as Box2D:

- `src/engine/collide.ts:137-140` creates `const stateChanged = new Set<number>()`.
- `src/engine/collide.ts:229` iterates `for (const contactId of stateChanged)`.
- The contact ids are inserted while iterating gathered contact sims in graph-array
  order followed by awake-set `contactSims` order (`src/engine/collide.ts:125-131`).

Box2D instead iterates set bits in increasing contact id:

- `box2d/src/physics_world.c:697-704` loops bitset blocks, uses `b2CTZ64(bits)`,
  and computes `contactId = 64 * k + ctz`.

## Why it is wrong

Contact-array order is not stable contact-id order. Contacts are moved between
`state.graphContactSims` and `awakeSet.contactSims`, and both arrays use
swap-remove. Once any previous start/stop/disjoint transition has occurred, the
gather order can differ from ascending contact id.

That matters because the state-change loop itself mutates those arrays:

- started-touching contacts are added to the graph and swap-removed from the awake
  set;
- stopped-touching contacts are added to the awake set and removed from the graph;
- disjoint contacts are destroyed.

Processing the same changed contacts in a different order can produce a different
post-loop graph/awake contact order. The solver iterates `state.graphContactSims`,
so a later step can solve constraints in a different order from Box2D even with the
same contact ids and manifolds.

This is a parity issue rather than a duplicate of the existing lifecycle teardown
issues. Those issue stale contacts and invalid contacts; this issue affects valid
contacts that are already in the M3 collide state-change path.

## Impacted code

- `src/engine/collide.ts:125-140` gathers contacts and records state changes in
  gather/insertion order.
- `src/engine/collide.ts:229-287` processes changed contacts in that order while
  mutating graph/awake contact arrays.
- `src/engine/solver.ts` consumes `state.graphContactSims` in array order during
  solver preparation and solving, so the changed ordering can affect numeric
  results.

## Impacted features

Any scene with multiple contacts changing state in the same step, especially stacks
or piles where contacts start/stop/disjoin together. Simple HelloWorld parity can
still pass because it has too few simultaneous contact transitions to expose the
ordering difference.

## How to reproduce

Create at least three contacts, then cause two or more to start or stop touching in
the same step after earlier contact transitions have already swap-removed or moved
entries between `awakeSet.contactSims` and `state.graphContactSims`. Instrument
`collide()` to log both:

1. the current implementation's `stateChanged` iteration order;
2. the sorted ascending contact ids in the same set.

Once the two orders differ, the graph/awake arrays after the state-change loop can
also differ from the Box2D order, and the next solver pass will iterate constraints
in that diverged order.

## Possible solution

Replace the `Set<number>` state-change queue with a deterministic contact-id order
that matches Box2D. The simplest fix is to keep the `Set` for deduplication, then
sort before processing:

```ts
for (const contactId of [...stateChanged].sort((a, b) => a - b)) {
  // existing state-change handling
}
```

If allocation becomes a concern later, use a small bitset keyed by contact id like
Box2D. The important contract is ascending contact-id processing, not gather order.
