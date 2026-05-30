# M4 — ContactEvents / HitEvents opt-in is not synced when the component is added or removed after shape creation

**Milestone:** M4 (VP-21a / VP-22 — contact begin/end + hit event recording)
**Severity:** medium — silent feature gap; the documented "add an event component to a shape" contract only works if the component is present at the exact frame the shape first enters the engine.

## What is wrong

A shape's engine-side event opt-in flags are derived from the presence of the
ECS event components **once**, in `PhysicsShapeLifecycle.enter`:

```ts
// src/systems/shape_lifecycle.ts:359-361
enableContactEvents: e.get(ContactEvents) !== undefined,
enableHitEvents: e.get(HitEvents) !== undefined,
enableSensorEvents: e.get(SensorEvents) !== undefined,
```

These flow into `InternalShape.enableContactEvents` / `enableHitEvents`
(single shape: `shape_lifecycle.ts:506-508`; chain segments: `:400-402`),
and from there into the contact flags at contact-creation time
(`contact.ts:320` → `CONTACT_ENABLE_CONTACT_EVENTS`, `contact.ts:637` →
`SIM_ENABLE_HIT_EVENT`).

**Nothing updates these flags afterwards.** `PhysicsMaterialFilterSync`
(the system that propagates runtime component changes to `InternalShape`)
handles `Material` and `CollisionFilter` updates only — there is no
`.update(...)` / `onAdd` / `onRemove` handler for `ContactEvents` or
`HitEvents` anywhere in `src/systems/`. (Confirmed by grep: the only
non-test reads of `enableContactEvents` / `enableHitEvents` are the
creation-time assignments above.)

Consequences:

- `shapeEntity.add(ContactEvents)` **after** the shape has been created is a
  silent no-op: the shape keeps `enableContactEvents = false`, the
  `CONTACT_ENABLE_CONTACT_EVENTS` flag is never set on its contacts, and the
  shape never receives a single begin/end event.
- `shapeEntity.remove(ContactEvents)` likewise never clears the flag — the
  engine keeps recording begin/end events (the publish side then silently
  drops them because the component is gone, so there is no *visible* leak, but
  the engine still pays the recording cost and the flag is stale).
- Same for `HitEvents` / `enableHitEvents`.

## Why it is wrong

1. **It diverges from Box2D, which makes these runtime-mutable on purpose.**
   Box2D exposes `b2Shape_EnableContactEvents` / `b2Shape_EnableHitEvents`
   (shape.c:~1350-1370) precisely so a shape can subscribe/unsubscribe at
   runtime. Tying the flag to one-shot component-presence at `enter` drops
   that capability without recording a deviation in PLAN.md → _Settled
   Decisions_ or a `Carried into MX` line. (Per the working rules, an
   intentional Box2D divergence must be recorded; this one is not.)

2. **It contradicts the public contract in `docs/events.md`.** That doc frames
   event components as ordinary opt-in Vecs components ("Add an event component
   to a shape entity when you want that shape to receive events… If the
   component is missing, vecs-physics does not report those events"). Nothing
   in the doc says the component must be present at the instant of shape
   creation and can never be toggled later. A user following the documented
   mental model — spawn a shape, later `add(ContactEvents)` when gameplay needs
   it — gets silence with no error.

## Impacted code

- `src/systems/shape_lifecycle.ts:359-361, 400-402, 506-508` (one-shot read).
- `src/systems/material_filter_sync.ts` (the natural home for the missing
  `.update`/add/remove handlers — it already owns runtime sync for the other
  per-shape fields, and its header even lists `b2Shape_EnableSensorEvents`
  among its "upstream sources" while never actually handling it).
- Engine consumers that read the stale flag: `engine/contact.ts:320,637`,
  `engine/collide.ts:274,303`, `engine/solver.ts` `gatherHitEvents`.

## Impacted features

- Dynamic contact-event subscription (e.g. only listen for contacts after a
  pickup is armed).
- Dynamic hit-event subscription (e.g. enable impact damage only while a
  projectile is "live").

## How to reproduce

```ts
const ground = world.entity().add(Body); // static
world.entity().set(ChildOf, { target: ground }).set(Box, { hx: 5, hy: 0.5 });

const ball = world.entity().set(Position, { x: 0, y: 3 }).set(Body, { type: "dynamic" });
const ballShape = world.entity().set(ChildOf, { target: ball }).set(Circle, { radius: 0.5 });

world.start();
world.progress(0, 1 / 60); // shape created WITHOUT ContactEvents

ballShape.add(ContactEvents); // subscribe at runtime

// Drive the ball into the ground for many steps…
for (let i = 0; i < 120; i++) world.progress(i / 60, 1 / 60);

// EXPECTED: ballShape.get(ContactEvents).begin received a begin event.
// ACTUAL:   never — enableContactEvents was latched false at creation,
//           so CONTACT_ENABLE_CONTACT_EVENTS is never set on the contact.
```

A symmetric repro with `HitEvents` (fast impact, then `add(HitEvents)`) shows
the same silence.

## Hint at a possible fix

Add the missing runtime sync to `PhysicsMaterialFilterSync` (or a small
dedicated system), mirroring how `CollisionFilter` is already handled:

- React to `ContactEvents` / `HitEvents` add **and** remove on a shape entity
  (component add/remove, not `.update`, since these payloads carry no
  meaningful data — the *presence* is the signal). On change, set
  `InternalShape.enableContactEvents` / `enableHitEvents` for the single shape
  or every chain segment.
- Refresh the affected contacts' flags. Box2D's `b2Shape_EnableContactEvents`
  walks the shape's contact list and updates `b2_contactEnableContactEvents`
  on each existing contact (it does **not** wait for re-creation); do the same,
  or document a one-frame-late deviation if recomputing per-contact is deferred.
- The `SensorEvents` / sensor-visitor side of this same gap is filed separately
  (`M4-runtime-sensor-event-opt-in-not-synced.md`); a unified handler covering
  all three event components would resolve both. Whoever picks this up should
  coordinate so the two fixes do not collide.

If runtime toggling is deliberately out of scope for v1, that is a legitimate
choice — but it must be recorded as a Box2D deviation in PLAN.md and the
`docs/events.md` contract should state that event components are read at shape
creation only.
