# Sensor Shapes Are Excluded From Body Mass (Diverges From Box2D)

## What is wrong

`updateBodyMassData` skips every sensor shape when accumulating a body's mass,
center of mass, and rotational inertia. Box2D does not: its mass walk skips only
shapes whose `density == 0`. A sensor shape with nonzero density contributes mass
in Box2D, and the default shape density is `1`.

The result: a dynamic body whose mass comes (wholly or partly) from sensor shapes
gets a smaller mass — or zero mass — than Box2D would give it. A dynamic body
whose _only_ shape is a sensor ends up with `invMass = 0` (infinite mass) in the
port but a finite mass in Box2D, so it will not respond to gravity, forces, or
impulses where Box2D would have it move.

## Why it is wrong

The port intends Box2D-compatible simulation behaviour, and `PROGRESS.md` (VP-12)
describes the mass walk as "skip sensors/zero-density" as though that mirrors
Box2D. It does not.

Box2D `b2UpdateBodyMassData` (`box2d/src/body.c`) iterates the body's whole shape
list (`headShapeId` → `nextShapeId`) and the only per-shape exclusion is:

```c
if ( s->density == 0.0f )
{
    masses[shapeIndex] = (b2MassData){ 0 };
    shapeIndex += 1;
    continue;
}
```

There is no `isSensor` check. Sensor shapes are created with `shape->density =
def->density` (`box2d/src/shape.c:47`) and the default density is `1.0`
(`b2DefaultShapeDef` in `box2d/src/types.c`). `b2ComputeShapeMass`
(`box2d/src/shape.c`) computes mass for circle/capsule/polygon regardless of the
sensor flag. So in Box2D a default-density sensor on a dynamic body adds mass,
moves the center of mass, and adds rotational inertia.

Note the port already handles extents the Box2D way — its extent loop walks all
shapes including sensors — so only the mass/CoM/inertia accumulation diverges,
which makes the inconsistency easy to miss.

## Impacted code

- `src/engine/mass.ts:470` — `if (s.sensor || s.density === 0)` excludes sensors
  from the mass-weighted CoM sum (pass 1) and the parallel-axis inertia sum
  (pass 2, via the zeroed `massDataArr` entry).
- `architecture/PROGRESS.md` (VP-12 status) — records the skip as if it were
  Box2D-faithful; it is an undocumented deviation.

## Impacted features

- Dynamic bodies that carry sensor shapes (e.g. a dynamic projectile with a
  trigger volume, or a body whose mass is meant to come from a sensor fixture).
- A dynamic body whose only shape is a sensor: `invMass = 0` in the port, finite
  in Box2D — it silently will not fall or react to forces.
- Center of mass and inertia of any compound body that mixes solid and sensor
  shapes — lever arms and angular response will differ from Box2D once the M3
  solver lands.
- Box2D parity tests that create dynamic sensor bodies.

## How to reproduce

1. Create a dynamic `Body` at the origin.
2. Add a child `Circle { radius: 1 }` with `Sensor` and default `Material`
   (density `1`).
3. `world.progress(...)` so `PhysicsMassRecompute` runs.

Expected (Box2D): `sim.invMass = 1 / (π·1²·1) ≈ 0.318`; the body has finite mass
and falls under gravity.

Current behavior: the sensor is skipped, `totalMass = 0`, so `sim.invMass = 0`
(infinite mass) and the body does not move.

A mixed-shape variant (one solid circle + one offset sensor circle) shows the CoM
and inertia diverging from Box2D rather than going to zero.

## Possible solutions

- Match Box2D: drop the `s.sensor` term and skip only `s.density === 0` in the
  mass accumulation pass. Sensors with default density then contribute mass,
  exactly as Box2D.
- If excluding sensors from mass is a deliberate, desired API decision for
  vecs-physics (it is defensible — many engines treat sensors as massless), then
  it must be recorded as an explicit **deviation** in `PLAN.md` → _Settled
  Decisions_ and `PROGRESS.md`, and the "skip sensors/zero-density" wording must
  stop implying it mirrors Box2D. The parity-test expectations for dynamic sensor
  bodies need to be set accordingly.

Either way, add a mass test for a dynamic body with a sensor shape so the chosen
contract is pinned before the M3 solver consumes `invMass`/`invInertia`.
