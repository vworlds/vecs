# M3: Live contact invalidation is missing

## Summary

M3 added persistent contacts and the solver, but several live mutation paths still
leave existing contacts in place after the relationship between the two shapes is
no longer valid. This is separate from destruction-time teardown: the entities and
shape records remain alive, but the contact should be destroyed, refiltered, or
re-created because the pair is no longer the same physical constraint.

## What is wrong

The M2 handoff explicitly carried contact-dependent lifecycle work into M3:
contact teardown on shape type changes, contact refilter on `CollisionFilter`
changes, dynamic `Sensor` toggles, and contact creation/teardown around broad-phase
proxy transitions. M3 wired contact creation and solving, but the systems that
mutate existing shapes and bodies still only update local fields and proxies.

The current code leaves stale contacts for at least these paths:

- `PhysicsMaterialFilterSync.update(CollisionFilter)` updates `categoryBits`,
  `maskBits`, and `groupIndex`, but does not destroy contacts that are now
  rejected by `shouldShapesCollide`.
- `PhysicsBodyLifecycle.update(Body)` destroys/recreates proxies for disable,
  enable, and type changes, but does not destroy existing contacts for disabled
  bodies or pairs that became static-static or otherwise invalid.
- `PhysicsShapeLifecycle` geometry updates and chain rebuilds mutate a shape's
  `type`/`geometry` or replace chain segment shapes without invalidating contacts
  involving the old geometry.
- `PhysicsShapeLifecycle.update(ChildOf)` reparents a shape to a new body and
  moves its proxy, but leaves contacts that were created against the old body.

## Why it is wrong

`BroadPhase.pairSet` now means "a contact exists" and is maintained by
`createContact`/`destroyContact`. If a live mutation makes an existing contact
invalid but does not call `destroyContact`, the pair key remains in `pairSet` and
the broad phase will not emit the pair again. That prevents the normal
`makePairCreateCallback` filtering and canonical `createContact` path from
re-evaluating the pair under the new state.

This causes two classes of bugs:

- Invalid contacts keep solving. A body changed to `enabled: false`, or a pair
  whose filters no longer overlap, can continue to participate in
  `state.graphContactSims` until the cached fat AABBs separate.
- Valid contacts fail to reappear. A pair filtered out by an old contact or stale
  pair key may not be reconsidered after filters, body type, geometry, or parent
  body change again.

This also contradicts the M3 contract recorded in `PROGRESS.md`, which lists the
M2 contact-dependent deferrals as carried into M3.

## Impacted code

- `src/systems/material_filter_sync.ts:70-94` updates collision filters but still
  contains the "deferred to M3" refilter comments.
- `src/systems/lifecycle.ts:199-228` manages proxies for disable/enable/type
  changes but leaves contacts and `pairSet` entries untouched.
- `src/systems/shape_lifecycle.ts:540-648` rebuilds geometry or chain segments
  without destroying contacts involving the old shape records.
- `src/systems/shape_lifecycle.ts:655-751` reparents shapes without destroying
  contacts from the old body pairing.
- `src/engine/contact.ts:383-442` has the needed `destroyContact` primitive, but
  no lifecycle/refilter helper calls it for these live mutation paths.

## Impacted features

- Runtime collision-filter edits.
- Enabling/disabling bodies after they have touched another shape.
- Changing a body between static, kinematic, and dynamic after contacts exist.
- Rebuilding shape geometry or chains after contacts exist.
- Reparenting a shape from one body to another after contacts exist.

Current scenario tests do not cover these paths; they create bodies and then run a
stable simulation without live structural/filter mutations.

## How to reproduce

One minimal repro is a filter change after contact creation:

```ts
const world = new World();
installPhysics(world);
world.start();

const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -10 });
const groundShape = world
  .entity()
  .set(ChildOf, { target: ground })
  .set(Box, { width: 100, height: 20 });

const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 1 });
const shape = world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

world.progress(16, 16); // contact is created and can move into graphContactSims

shape.set(CollisionFilter, { categoryBits: 0x2, maskBits: 0x0, groupIndex: 0 });
groundShape.set(CollisionFilter, { categoryBits: 0x1, maskBits: 0x0, groupIndex: 0 });

world.progress(32, 16); // stale contact remains instead of being destroyed/refiltered
```

A second repro is to set the dynamic body's `Body.enabled` to `false` after it is
touching the ground. Its proxies are removed, but the existing contact remains in
contact storage / graph state and can keep participating in collision solving.

## Possible solution

Add a contact-invalidation helper in the engine layer that walks a body's contact
list and calls `destroyContact` for contacts that match a predicate. Use it from
the live mutation paths before mutating the shape/body fields that affect contact
validity.

Likely call sites:

- On `CollisionFilter` changes, destroy contacts for the updated shape whose other
  shape no longer passes `shouldShapesCollide`.
- On body disable and type change, destroy all contacts on the body before moving
  proxies or solver sets.
- On geometry type changes, chain rebuilds, and reparenting, destroy contacts that
  reference the affected shape handles before mutating/replacing/reparenting them.

The helper should be idempotent and robust to `destroyContact` swap-removing sims
while the walk is in progress: snapshot the next contact key before destroying the
current contact.
