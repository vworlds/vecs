# M3: Body type and enable updates miss mass, dynamic-flag, and island bookkeeping

## Summary

`PhysicsBodyLifecycle.update(Body)` handles solver-set transfer and broad-phase
proxy movement, but it does not complete the non-contact Box2D bookkeeping for body
type and enabled-state changes. Separate from the existing stale-contact issue,
type/enable transitions can leave mass properties, solver dynamic flags, and island
membership inconsistent with the body record.

## What is wrong

The current update path does only these stages:

- destroy proxies when disabling;
- transfer the body between solver sets;
- assign `record.type = newType`;
- recreate or move proxies on enable/type change.

See `src/systems/lifecycle.ts:193-228`.

Missing work:

- Type changes do not mark mass dirty or recompute mass. A static or kinematic body
  changed to dynamic can keep `invMass = 0`; a dynamic body changed to static or
  kinematic can keep old mass values until some unrelated shape/material change
  dirties mass.
- Dynamic solver flags are not resynchronised when type changes. `DYNAMIC_FLAG` is
  seeded only on body creation (`src/engine/solver_set.ts:91-98`), and
  `transferBody` creates a new `BodyState` from the existing `sim.flags`
  (`src/engine/solver_set.ts:183-195`). The solver writes velocity results only
  when `BodyState.flags & DYNAMIC_FLAG` (`src/engine/solver.ts:481-489`).
- Island membership is not updated when a body crosses static/awake or
  disabled/awake boundaries. `createBody` creates an island for awake non-static
  bodies (`src/engine/solver_set.ts:120-126`), but update-time transfers do not
  call `createIslandForBody` or `removeBodyFromIsland`.

The PLAN requires the missing type-change work:

- `architecture/PLAN.md:1056-1064` says type changes destroy contacts, move solver
  sets, re-init mass, and re-broadphase proxies.

The Box2D reference does this bookkeeping explicitly:

- `box2d/src/body.c:1191-1201` updates `body->type` and sets/clears
  `b2_dynamicFlag` during `b2Body_SetType`.
- `box2d/src/body.c:1210-1220` creates/removes island participation when crossing
  static/non-static.
- `box2d/src/body.c:1292-1295` syncs body flags and updates mass data after type
  change.
- `box2d/src/body.c:1670-1674` removes a disabled body from its island before
  transferring it to the disabled set.
- `box2d/src/body.c:1714-1717` creates an island when enabling a non-static body.

## Why it is wrong

The contact solver treats the dynamic flag as authoritative for writing impulses
back to body states. A body whose public `Body.type` has changed but whose state
flags still reflect the old type can be solved as the wrong kind of body.

Mass has the same problem. `PhysicsMassRecompute` only scans bodies with
`body.massDirty` set (`src/systems/mass_recompute.ts:31-50`). Type changes affect
mass by definition: static/kinematic bodies should have zero inverse mass/inertia,
while dynamic bodies should recompute from attached shapes. Without setting the
dirty flag or recomputing immediately, the body can run the next step with stale
mass properties.

Island membership also becomes structurally inconsistent. M3 introduced islands as
the faithful contact-link substrate, and later milestones depend on those records
for sleep and split. Leaving a disabled body in an island, or failing to create an
island for a newly enabled/dynamic body, breaks that contract even before sleep
uses the islands.

This is not a duplicate of `M3-live-contact-invalidation-missing.md`. That issue is
about destroying/refiltering stale contacts and pair keys. This issue remains even
after contacts are correctly invalidated: the body itself still needs mass, flag,
and island bookkeeping.

## Impacted code

- `src/systems/lifecycle.ts:193-228` body update path.
- `src/engine/solver_set.ts:91-98` creation-time-only `DYNAMIC_FLAG` seeding.
- `src/engine/solver_set.ts:183-195` awake-state creation from stale `sim.flags`.
- `src/engine/solver.ts:481-489` dynamic-flag gate for solver writeback.
- `src/systems/mass_recompute.ts:31-50` mass recompute only runs when
  `massDirty` is set.
- `src/engine/island.ts` has the needed island helpers, but update-time body
  transitions do not call them.

## Impacted features

- Changing `Body.type` at runtime.
- Toggling `Body.enabled` at runtime.
- Any future sleep/island-split logic that assumes island membership matches the
  current solver set and body type.

## How to reproduce

Mass staleness:

```ts
const world = new World();
installPhysics(world);
world.start();

const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 5 });
world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

world.progress(16, 16); // static body mass path leaves invMass = 0
body.set(Body, { type: BodyType.Dynamic });
world.progress(32, 16); // no massDirty from type change, so it can remain infinite mass
```

Dynamic-flag staleness can be observed by changing a dynamic body to kinematic or
static after creation, then inspecting the awake `BodyState.flags` or solver
writeback behavior during contact solving.

Island staleness can be observed by toggling a non-static body to disabled and
checking that its old `islandId` remains populated unless contacts or destruction
happen to clean it indirectly.

## Possible solution

Make the body update path mirror Box2D's type/enable sequencing after contact
teardown is added:

- On type change, set/clear the dynamic flag on the body/sim and ensure the
  current or newly-created awake `BodyState` receives matching flags.
- Mark mass dirty or call `updateBodyMassData` immediately when `Body.type`
  changes.
- When crossing into the disabled set, remove island membership before transfer.
- When enabling a non-static body, create island membership after transfer.
- When crossing static to non-static, create an island; when crossing non-static to
  static, remove the island.

The existing `createIslandForBody` / `removeBodyFromIsland` helpers are the right
building blocks, but the body update code needs to call them in the same stage
order as Box2D.
