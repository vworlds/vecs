# M3: MotionLocks and allowFastRotation are not wired into the engine

## Summary

The `MotionLocks` component and `Body.allowFastRotation` field are part of the
public API contract (defaults table in PLAN.md, component registration in
install.ts), but their values are never propagated into the engine. The lockdown
logic in `integratePositions` and the fast-rotation guard read flags from
`BodyState.flags`/`BodySim.flags`, but those flag bits are never populated by
the body lifecycle.

## What is wrong

`PhysicsBodyLifecycle.enter` reads `Damping` and `GravityScale` from the entity
and writes them into the body sim, but it does **not** read `MotionLocks` or
`Body.allowFastRotation`. The lock bits (`LOCK_LINEAR_X`, `LOCK_LINEAR_Y`,
`LOCK_ANGULAR_Z`) and `ALLOW_FAST_ROTATION` are never set on either `BodySim.flags`
or `BodyState.flags`. Consequently the lockdown logic in
`integratePositions` (solver.ts:700–718) and the fast-rotation guard
(solver.ts:714) are dead code:

```ts
// solver.ts:700-703
let vx = st.flags & LOCK_LINEAR_X ? 0.0 : st.vx;
let vy = st.flags & LOCK_LINEAR_Y ? 0.0 : st.vy;
let w = st.flags & LOCK_ANGULAR_Z ? 0.0 : st.omega;
```

No lock flag is ever set, so velocity is never zeroed. A user can write
`body.set(MotionLocks, { x: true, y: true, rotation: true })` and the body will
still move.

Additionally, the M1 review follow-up (`PROGRESS.md` line 545–551: "transferBody
seeds BodyState.flags from sim.flags, box2d uses body.flags") flags the seeding
point in `transferBody`, but without the lifecycle wiring the lock bits to
`sim.flags` first, there is nothing to seed.

## Why it is wrong

- `MotionLocks` is a documented, registered public component with defaults that
  the user expects to work.
- `Body.allowFastRotation` defaults to `false` and is documented in the PLAN.
  Without wiring, a body that should be angular-speed-limited can spin faster
  than `MAX_ROTATION * invDt` if the solver drives it there.
- These are general body features, not tied to kinematic targets (M4). They are
  part of the core body integration and should have been wired in M1 (VP-5) or
  the M3 body-update path.

## Impacted code

- `src/systems/lifecycle.ts:130–169` — `enter` callback reads `Damping` and
  `GravityScale` but not `MotionLocks` or `Body.allowFastRotation`.
- `src/engine/body.ts:174–200` — `makeBodySim` never sets lock or
  fast-rotation flags in `sim.flags`.
- `src/engine/solver_set.ts:83–128` — `createBody` sets `DYNAMIC_FLAG` on
  `sim.flags` but not the lock bits.
- `src/engine/solver_set.ts:159–199` — `transferBody` seeds `BodyState.flags`
  from `sim.flags` (M1 follow-up comment), but `sim.flags` never carries
  the lock bits.
- `src/engine/solver.ts:700–718` — `integratePositions` reads lock/fast-rotation
  flags from `BodyState.flags` that are always zero.

## Impacted features

- Linear motion locking (body slides in one axis only).
- Angular motion locking (body does not rotate).
- Fast rotation toggling (angular speed cap bypass).

## How to reproduce

```ts
const world = new World();
installPhysics(world);
world.start();

const body = world
  .entity()
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 0, y: 5 })
  .set(MotionLocks, { x: false, y: true, rotation: true });

// Shape so it collides with floor.
const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -10 });
world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 20 });
world.entity().set(ChildOf, { target: body }).set(Circle, { radius: 1 });

// Step. Body falls in y despite y being locked.
world.progress(16, 16);
const v = body.get(LinearVelocity);
// v.y should be 0 but will be negative (gravity is not locked out).
```

## Possible solution

In `PhysicsBodyLifecycle.enter`, after writing velocity, read `MotionLocks` from
the entity and set the corresponding lock bits on both `sim.flags` and (for the
awake set) `bodyState.flags`:

```ts
const locks = e.get(MotionLocks);
if (locks) {
  if (locks.x) {
    sim.flags |= LOCK_LINEAR_X;
    bodyState.flags |= LOCK_LINEAR_X;
  }
  if (locks.y) {
    sim.flags |= LOCK_LINEAR_Y;
    bodyState.flags |= LOCK_LINEAR_Y;
  }
  if (locks.rotation) {
    sim.flags |= LOCK_ANGULAR_Z;
    bodyState.flags |= LOCK_ANGULAR_Z;
  }
}
```

For `allowFastRotation`, read `Body.allowFastRotation` and set
`ALLOW_FAST_ROTATION` on the sim flags.

In `PhysicsBodyLifecycle.update(Body)`, handle changes to `MotionLocks` and
`allowFastRotation` by updating the flags on the sim and body state. When
`transferBody` seeds the new state from `sim.flags`, the lock bits will
automatically propagate.

The `InternalBody` has no flags field; either add one and make
`transferBody` seed `BodyState.flags` from `body.flags` as box2d does
(the M1 review recommendation), or seed both `sim.flags` and `state.flags`
identically in the lifecycle so the transfer seeding from `sim.flags`
stays correct.
