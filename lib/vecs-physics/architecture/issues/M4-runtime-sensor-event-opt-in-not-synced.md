# M4: Runtime sensor and event opt-in components are not synced into internal shapes

## What is wrong

`Sensor`, `ContactEvents`, `SensorEvents`, and `HitEvents` are only read when an internal shape is created. Adding or removing these components after the shape has entered the physics world does not update the existing `InternalShape`, its contact flags, or `SensorStorage`.

This means runtime opt-in behaves differently depending on whether the component was present before the shape was created:

- Adding `Sensor` to an existing solid shape does not convert it into a sensor.
- Removing `Sensor` from an existing sensor does not convert it back into a solid shape.
- Adding `ContactEvents`, `SensorEvents`, or `HitEvents` to an existing shape does not enable event production for existing or future contacts/overlaps unless the shape is recreated.
- Removing event components stops ECS publication because `PhysicsEvents` checks the component at publish time, but the engine may continue collecting raw events for stale opt-in flags.

## Why this is wrong

The public docs describe events as component opt-in: add the event component when the shape should receive events. Sensor docs similarly say a shape becomes a sensor by adding `Sensor`. In a Vecs component model, users reasonably expect component add/remove after creation to be meaningful unless explicitly documented otherwise.

The architecture plan also calls out update handling for `Sensor` changes through shape proxy/contact recreation. M3 deferred the dynamic `Sensor` toggle until sensors landed; M4 implements sensors but does not resolve that deferral and the final M4 carried-forward list no longer tracks it.

Box2D has explicit shape APIs for these toggles (`b2Shape_SetSensor`, `b2Shape_EnableContactEvents`, `b2Shape_EnableSensorEvents`, `b2Shape_EnableHitEvents` style state changes). The port should either implement equivalent component reactivity or document a creation-time-only contract. The current state silently accepts component changes while leaving engine state stale.

## Impacted code

- `src/systems/shape_lifecycle.ts`
  - `readMaterialOpts` reads `Sensor`, `ContactEvents`, `SensorEvents`, and `HitEvents` only during shape entry.
  - Shape creation copies those booleans into `InternalShape` and registers sensors in `SensorStorage` only once.
- `src/systems/material_filter_sync.ts`
  - Handles `Material` and `CollisionFilter` updates, but explicitly notes `Sensor` add/remove is not handled.
  - No update handling exists for `ContactEvents`, `SensorEvents`, or `HitEvents` component add/remove.
- `src/engine/contact.ts`
  - Contact and hit event flags are derived from `InternalShape.enableContactEvents` / `enableHitEvents` at contact creation/update time, so stale shape flags produce stale contact behavior.
- `src/engine/sensor.ts`
  - Sensor pass requires `InternalShape.sensor` and `SensorStorage` registration; runtime `Sensor` adds never create a sensor record.

## Impacted features

- Runtime sensor toggles.
- Runtime contact begin/end event opt-in.
- Runtime sensor begin/end event opt-in.
- Runtime hit event opt-in.
- Event collection performance and correctness after event components are removed.

## How to reproduce

1. Create a body with a box shape without `ContactEvents`.
2. Step once so the shape enters physics.
3. Add `ContactEvents` to that existing shape.
4. Move another solid shape into contact and step.
5. The `ContactEvents` component exists but no begin event is emitted because `InternalShape.enableContactEvents` remained `false`.

For sensors:

1. Create two overlapping solid shapes without `Sensor`.
2. Step once so both shapes enter physics.
3. Add `Sensor` and `SensorEvents` to one existing shape and `SensorEvents` to the other.
4. Step again.
5. No sensor begin event is emitted because the existing internal shape was not recreated as a sensor and no `SensorStorage` record was allocated.

## Possible solutions

- Add a dedicated sync system or extend `PhysicsMaterialFilterSync` to watch `Sensor`, `ContactEvents`, `SensorEvents`, and `HitEvents` add/remove/update events for existing shape entities.
- For `Sensor` toggles, destroy relevant contacts, update/recreate the shape proxy as needed, create/destroy the `SensorStorage` record, and preserve mass/proxy invariants.
- For contact and hit event opt-in changes, update all internal shapes for the entity/chain segments and refresh or recreate existing contact flags so currently touching pairs follow the new setting.
- For sensor event opt-in changes, update `enableSensorEvents` on the shape/chain segments and let the next sensor overlap pass produce the correct begin/end diff. If disabling, consider whether existing overlaps should emit end events or simply stop reporting, matching the chosen Box2D parity behavior.
- Add regression tests that add/remove these components after shape creation, not only before the first physics step.
