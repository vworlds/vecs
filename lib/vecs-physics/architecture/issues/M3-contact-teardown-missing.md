# M3: Contact teardown on shape/body destruction is missing

## Summary

The contact-teardown work carried from M2 into M3 was not completed. When a shape
or body entity is destroyed, the orphaned contact records survive and will crash
the next `collide` pass.

## What is wrong

M2 explicitly deferred contact teardown to M3 as a hard dependency — the
contact graph didn't exist yet in M2, so shape removal and body removal could
not clean up contacts. PROGRESS.md collected the contract:

> **Carried into M3 (deferred work + contracts, collected for the solver team):**
> ... **Contact-dependent deferrals from M2:** contact teardown on shape
> removal/type-change (VP-11 `exit`); contact refilter on `CollisionFilter`
> change (VP-11b); dynamic `Sensor` toggle (VP-11b);
> `forcePairCreation` for a static shape's `invokeContactCreation` (VP-10).

M3 VP-18 (the integration ticket) wired the full collision step loop but did
not retrofit the lifecycle systems (`PhysicsShapeLifecycle.exit`,
`PhysicsBodyLifecycle.exit`) to tear down contacts.

## Why it is wrong

The crash path is deterministic:

1. A shape entity is destroyed (user calls `entity.destroy()` or removes the
   geometry component).
2. `PhysicsShapeLifecycle.exit` runs, destroying the `InternalShape` record and
   freeing its handle. The shape's contacts are NOT touched.
3. The contact records in `state.contacts.records` still reference the freed
   shape handle index (via `shapeIdA`/`shapeIdB`).
4. On the next step, `collide()` iterates over `contactSims` and calls
   `state.shapes.get(contactSim.shapeIdA)` — this hits a freed slot and throws
   `"no shape at index N"`.

Additionally, if the owning body is then destroyed: 5. `PhysicsBodyLifecycle.exit` calls `destroyBody`, which calls
`removeBodyFromIsland`. 6. `removeBodyFromIsland` asserts that the island has no contacts remaining
(`island.contacts.length !== 0` → throws). Since contacts were never
removed during step 2, this assertion fires.

## Impacted code

- `src/systems/shape_lifecycle.ts:494` (`exit` handler) — does not walk the
  body's contact list to destroy contacts belonging to the removed shape.
- `src/systems/lifecycle.ts:174` (`exit` handler) — does not walk the body's
  contact list before calling `destroyBody`.
- `src/systems/shape_lifecycle.ts:21-23` — the explicit "Deferred to M3" comment
  has not been resolved.

## Impacted features

Entity destruction (removing geometry from a body, or destroying a body entity)
while contacts exist. Not hit by current tests — all M3 scenario tests only
create entities and never destroy them. This is a latent crash bug, not a test
coverage gap.

## How to reproduce

Create two bodies with overlapping shapes, step once (contacts are created),
then destroy one shape. Next step will crash in `collide()`:

```
const world = new World();
installPhysics(world);
world.start();

const ground = world.entity().set(Body, { type: BodyType.Static })
  .set(Position, { x: 0, y: -10 });
const groundShape = world.entity().set(ChildOf, { target: ground })
  .set(Box, { width: 100, height: 20 });

const body = world.entity().set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 0, y: 4 });
const shape = world.entity().set(ChildOf, { target: body })
  .set(Box, { width: 2, height: 2 });

// Step to create contacts
world.progress(16, 16);
// Destroy the shape
shape.destroy();
// Next step crashes
world.progress(32, 16);
```

## Possible solution

In `PhysicsShapeLifecycle.exit`, before calling `destroyShape`, walk the owning
body's contact list and destroy every contact that references this shape's
handle index. The iteration pattern mirrors how `destroyContact` walks edges —
walk `bodyRecord.headContactKey` using the `(key>>1, key&1)` encoding, checking
whether either `shapeIdA` or `shapeIdB` matches the freed shape index, and
calling `destroyContact` for each match.

For `PhysicsBodyLifecycle.exit`, the same pattern: walk `headContactKey` and
destroy all contacts before calling `destroyBody`. The island will then be a
clean singleton (no contacts), satisfying `removeBodyFromIsland`'s assertion.

Both paths should be idempotent — check that the contact's record still exists
before attempting to destroy it (shape exit may run multiple times if multiple
shapes on the same body are being destroyed in the same frame).

The fix should also handle the `.update(ChildOf)` reparenting path: when a shape
moves from one body to another, its contacts under the old body should be
destroyed (they reference shape handles relative to the old body's solver-set
position, which may be stale).
