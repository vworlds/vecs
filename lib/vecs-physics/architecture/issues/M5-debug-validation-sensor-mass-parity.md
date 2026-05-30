# M5 Debug Validation Treats Sensor Shapes As Massless

## What is wrong

`PhysicsDebugValidation` reports `dynamic-body-without-density` for a dynamic body whose only positive-density shape is marked `Sensor`.

That is not consistent with the engine or with the Box2D parity decision already made in M2/M3: sensor shapes contribute to body mass when their density is non-zero. Box2D's `b2UpdateBodyMassData` skips only `density == 0` shapes; it does not skip `isSensor` shapes.

## Why it is wrong

The validator is supposed to warn about structures that normal mode ignores or that produce zero mass. A dynamic body with a positive-density sensor shape does not have zero mass in vecs-physics today:

- `src/engine/mass.ts` explicitly documents and implements that sensor shapes are included when `density !== 0`.
- `tests/engine/mass.test.ts` and `tests/lifecycle/mass_flag_sync.test.ts` pin the Box2D parity behavior.
- `PROGRESS.md` records the M2/M3 correction: “sensor shapes now contribute to body mass (skip only `density === 0`)”.

The M5 debug validator and docs reintroduced the older, incorrect assumption by requiring a “non-sensor” positive-density shape.

## Impacted code

- `src/systems/debug.ts`
  - `_validateBodyEntities` skips every child with `Sensor` before checking `Material.density`.
  - The warning text says “non-sensor shapes all have density 0”.
- `docs/debug-validation.md`
  - The `dynamic-body-without-density` description says “no non-sensor shape with non-zero density”.
  - The “Dynamic Body Density” section says mass normally comes from non-sensor shapes.
- `tests/debug/debug_validation.test.ts`
  - The test named `warns when only sensor shapes have positive density` locks in the incorrect behavior.

## Impacted features

- Debug validation emits false positives for valid dynamic sensor bodies.
- Users following debug output may add unnecessary non-sensor shapes or remove `Sensor` from bodies that are intentionally sensor-only but still require mass, velocity, or sleep behavior.
- The debug documentation contradicts the engine's mass model and the existing parity tests.

## How to reproduce

Create a debug-enabled world with a dynamic body and one child sensor shape with default or positive density:

```ts
const messages: string[] = [];
const world = new World();
installPhysics(world, { debug: true, debugSink: (message) => messages.push(message) });

const body = world.entity().set(Body, { type: BodyType.Dynamic });
world.entity().set(ChildOf, { target: body }).set(Circle).set(Sensor).set(Material, { density: 1 });

world.start();
world.progress(0, 1000 / 60);
```

Expected: no `dynamic-body-without-density` warning, because the body has non-zero mass.

Actual: `PhysicsDebugValidation` emits `dynamic-body-without-density`.

## Possible solution

Make the validator match `updateBodyMassData`: count any child shape with `density > 0`, regardless of whether it has `Sensor`. Update the warning/docs/tests from “non-sensor shape” to “shape with non-zero density”. Keep warning for bodies with no shapes or only `density === 0` shapes.
