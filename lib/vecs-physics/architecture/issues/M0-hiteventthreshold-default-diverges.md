# M0 — `hitEventThreshold` default diverges from Box2D (10.0 vs 1.0), unrecorded

## What is wrong

`installPhysics`'s resolved default for `hitEventThreshold` is **10.0**, but
Box2D's `b2DefaultWorldDef` sets it to **1.0** (`1.0f * lengthUnits`). The
divergence is not recorded as an intentional deviation anywhere
(`PLAN.md` → _Settled Decisions_, `PROGRESS.md`), and `install.ts` explicitly
advertises these as "Box2D-aligned defaults", which is false for this field.

The `PLAN.md` `PhysicsOptions` sketch carries the same wrong value
(`hitEventThreshold?: number; // m/s, default 10.0`), so this is a plan error
propagated verbatim into the code, not a deliberate, reviewed choice.

## Why it is wrong

Box2D v3.2.0, `box2d/src/types.c` `b2DefaultWorldDef`:

```c
b2WorldDef b2DefaultWorldDef( void )
{
	float lengthUnits = b2GetLengthUnitsPerMeter();
	b2WorldDef def = { 0 };
	def.gravity.x = 0.0f;
	def.gravity.y = -10.0f;
	def.hitEventThreshold = 1.0f * lengthUnits;   // <-- 1.0, not 10.0
	def.restitutionThreshold = 1.0f * lengthUnits;
	def.contactSpeed = 3.0f * lengthUnits;
	def.contactHertz = 30.0;
	def.contactDampingRatio = 10.0f;
	def.maximumLinearSpeed = 400.0f * lengthUnits;
	...
}
```

Every other world-def default in `resolveOptions` was checked against this same
function and matches (gravity `-10`, `restitutionThreshold 1.0`,
`contactSpeed 3.0`, `contactHertz 30`, `contactDampingRatio 10`,
`maximumLinearSpeed 400`, `enableSleep`/`enableContinuous true`,
`subSteps 4`). `hitEventThreshold` is the lone outlier — a 10× error.

This matters for two reasons beyond the raw number:

1. **Cardinal repo rule.** `PROGRESS.md` → _Working rules_: "Every intentional
   deviation from Box2D must be recorded as a deviation … Never describe a
   divergence in prose as if it mirrors Box2D." Here the code comment/JSDoc
   claims Box2D alignment while diverging silently — exactly the failure mode
   that rule exists to catch.
2. **Behavioural impact lands in M4.** Hit events (VP-22) gate on
   `|normalVelocity| > hitEventThreshold`. With the threshold 10× too high, a
   large class of impacts (everything between 1 m/s and 10 m/s) that Box2D
   reports as hits will produce **no** `HitEvent`. The HelloWorld / M3 scenarios
   do not exercise hit events, so nothing currently fails — this is a latent
   parity bug that will surface only once VP-22 is wired and tested, where it is
   far more expensive to track down.

## Impacted code

- `lib/vecs-physics/src/install.ts`
  - `PhysicsOptions.hitEventThreshold` doc comment (`// m/s, default 10.0`)
  - `resolveOptions`: `hitEventThreshold: opts.hitEventThreshold ?? 10.0`
- `lib/vecs-physics/architecture/PLAN.md` — the `PhysicsOptions` sketch
  (`hitEventThreshold?: number; // m/s, default 10.0`)
- Downstream consumer (not yet implemented): VP-22 `HitEvents` threshold scan
  (M4).

## Impacted features

- Hit events (M4 / VP-22): wrong default emission threshold.
- Any user relying on documented "Box2D-aligned defaults" who does not pass an
  explicit `hitEventThreshold`.

## How to reproduce

No runtime repro in M3 (hit events unimplemented). Static check:

```
grep hitEventThreshold lib/vecs-physics/src/install.ts
# => hitEventThreshold: opts.hitEventThreshold ?? 10.0
```

vs. `box2d/src/types.c` `b2DefaultWorldDef`: `def.hitEventThreshold = 1.0f * lengthUnits;`.

## Suggested fix

1. Change the default to `1.0` in `resolveOptions` and fix the two doc comments
   in `install.ts`.
2. Correct the `PhysicsOptions` sketch in `PLAN.md` to `default 1.0`.
3. Either drop the bespoke value entirely (so it is genuinely Box2D-aligned) or,
   if a 10.0 default is actually wanted for vecs, keep it but **record it** as an
   intentional deviation in `PLAN.md` → _Settled Decisions_ with the Box2D value
   quoted, per the repo rule.
4. Consider extending the defaults test (`tests/.../defaults`) to cover the
   resolved `PhysicsOptions` world-def defaults, not just the per-component
   defaults — this field slipped through precisely because the existing defaults
   test only checks component classes, not `resolveOptions`.
