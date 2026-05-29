# Material Updates Unconditionally Mark Body Mass Dirty

## What is wrong

`PhysicsMaterialFilterSync` marks the owning body `massDirty` on **every** Material update, regardless of whether `density` actually changed.

The helper `_maybeDirtyMass` at `material_filter_sync.ts:114-127` unconditionally writes `bodyRec.massDirty = true` for dynamic bodies. The `_newDensity` parameter (note the underscore prefix) is never read.

```ts
function _maybeDirtyMass(state: PhysicsState, shape: InternalShape, _newDensity: number): void {
  if (shape.bodyHandle.index === NULL_INDEX) return;
  const bodyRec = state.bodies.records[shape.bodyHandle.index];
  if (bodyRec === undefined) return;
  if (bodyRec.type !== DYNAMIC_BODY) return;
  // Mark dirty when density changed (old density is now updated on shape).
  bodyRec.massDirty = true;
}
```

Changing `friction`, `restitution`, `rollingResistance`, or `tangentSpeed` on a shape's `Material` component triggers a full body mass recompute on the next frame — work that produces identical results because the mass/inertia/CoM depend only on shape geometry, density, and local pose.

## Why it is wrong

The PLAN (`PLAN.md → PhysicsMaterialFilterSync`) is explicit: "If `density` changed and body is dynamic, mark `body.massDirty = true`. Cheap." The current implementation is not cheap — it triggers a full mass recompute for every material property change, including contact-surface properties that have nothing to do with mass.

During a simulation, users may adjust `friction` or `restitution` per-step (e.g. icy surface → rough surface transitions). Each such update re-walks the entire shape list for that body, recomputes every polygon's mass integral, and rewrites `BodySim.localCenter`, `invMass`, `invInertia`, and extents — all with identical values.

## Impacted code

- `src/systems/material_filter_sync.ts:44-48` calls `_maybeDirtyMass` for chain-segment material updates.
- `src/systems/material_filter_sync.ts:59-60` calls `_maybeDirtyMass` for single-shape material updates.
- `src/systems/material_filter_sync.ts:114-127` `_maybeDirtyMass` unconditionally sets `massDirty = true`.
- `src/systems/mass_recompute.ts:28-50` `PhysicsMassRecompute` re-walks every dirty body.
- `src/engine/mass.ts:412-556` `updateBodyMassData` re-integrates all shapes — cost scales with shape count.

## Impacted features

- Runtime `Material` edits that change only friction, restitution, or rolling resistance.
- Per-frame material transitions (e.g. variable-friction surfaces).
- CPU budget in steady-state when material properties update often but density is static.

## How to reproduce

Create a dynamic body with a child circle, progress once, then repeatedly set `Material { friction: 0.1 }`, `Material { friction: 0.2 }`, etc. between frames. Inspect `PhysicsMassRecompute`'s iteration: every frame recomputes the body mass despite density never changing.

## Possible solutions

Compare the new density against the current `shape.density` before dirtying:

```ts
function _maybeDirtyMass(state: PhysicsState, shape: InternalShape, newDensity: number): void {
  if (shape.density === newDensity) return; // already applied in _applyMaterial before this call
  const bodyRec = state.bodies.records[shape.bodyHandle.index];
  if (bodyRec === undefined) return;
  if (bodyRec.type !== DYNAMIC_BODY) return;
  bodyRec.massDirty = true;
}
```

Alternatively, dirty the body only when `mat.density !== shape.density` in the update callback itself and drop the `_maybeDirtyMass` helper entirely.

The chain-segment path applies the same fix.
