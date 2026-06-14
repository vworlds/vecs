# Events

Physics events let shape entities react to contacts, sensor overlaps, and high-speed impacts using normal Vecs component updates.

Events are opt-in. Add an event component to a shape entity when you want that shape to receive events. If the component is missing, `vecs-physics` does not report those events for that shape.

## Core Concept

Events belong to shape entities, not body entities.

```ts
const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

const playerShape = world
  .entity()
  .set(ChildOf, { target: player })
  .set(Box, { hx: 0.5, hy: 0.5 })
  .add(ContactEvents);
```

If `playerShape` touches another shape, `vecs-physics` updates its `ContactEvents` component and marks it modified. Vecs systems can listen with `.update(ContactEvents, ...)`.

```ts
world.system("LogContacts").update(ContactEvents, (shapeEntity, events) => {
  for (const event of events.begin) {
    console.log("started touching", event.other.eid);
  }
});
```

## Event Components

`vecs-physics` provides three event components.

```ts
export class ContactEvents {
  begin: ContactEvent[] = [];
  end: ContactEvent[] = [];
}

export class SensorEvents {
  begin: SensorEvent[] = [];
  end: SensorEvent[] = [];
}

export class HitEvents {
  hits: HitEvent[] = [];
}
```

Add only the event components you need. This keeps event collection cheap and explicit.

## Contact Events

Contact events report when two solid shapes start or stop touching.

```ts
export type ContactEvent = {
  other: Entity;
};
```

`other` is the other shape entity involved in the contact.

Minimal example:

```ts
const crate = world.entity().set(Position, { x: 0, y: 3 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: crate }).set(Box, { hx: 0.5, hy: 0.5 }).add(ContactEvents);

world.system("CrateContacts").update(ContactEvents, (shape, events) => {
  for (const event of events.begin) {
    console.log(`shape ${shape.eid} touched shape ${event.other.eid}`);
  }
});
```

If both shapes have `ContactEvents`, both receive their own event. If only one shape has `ContactEvents`, only that shape receives the event.

## Sensor Events

Sensor events report overlap begin/end for sensor shapes.

A shape becomes a sensor by adding `Sensor`.

```ts
export class Sensor {}
```

### The Sensor Detection Rule

Box2D v3 only reports an overlap to a sensor shape when **both** of these are
true:

- The sensor shape has `Sensor` + `SensorEvents` (so it is a sensor and wants
  to receive overlap events).
- The _visited_ shape — the other shape overlapping the sensor — opts in to
  sensor events too.

A plain solid shape (no `SensorEvents`, no `Sensor`) does **not** opt in, so
it is invisible to every sensor by default. To make a solid shape visible to
sensors, add `Detectable` to it:

```ts
export class Detectable {}
```

`Detectable` forces the shape to opt in to sensor visibility without making it
a sensor and without giving it `SensorEvents` of its own — the overlap is
still reported only to the sensor shape, never to the detectable shape.

```ts
export type SensorEvent = {
  other: Entity;
};
```

`other` is the other shape entity involved in the overlap.

Adding `SensorEvents` to the visited shape also opts it in (because
`SensorEvents` implies sensor visibility too), but that additionally makes the
visited shape collect its own (likely empty, since it is not a sensor)
`SensorEvents.begin`/`end` arrays. Prefer `Detectable` for solid shapes — it
says "let sensors see me" without implying "I receive sensor events".

Example: trigger a checkpoint when the player enters a zone.

```ts
class Checkpoint {}
class Player {}

const checkpoint = world.entity().set(Position, { x: 10, y: 0 }).add(Body);

world
  .entity()
  .set(ChildOf, { target: checkpoint })
  .set(Box, { hx: 2, hy: 1 })
  .add(Sensor)
  .add(SensorEvents)
  .add(Checkpoint);

const player = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .set(ChildOf, { target: player })
  .set(Circle, { radius: 0.5 })
  .add(Detectable)
  .add(Player);

world
  .system("CheckpointTriggers")
  .with({ all: [Checkpoint, SensorEvents] })
  .update(SensorEvents, (checkpointShape, events) => {
    for (const event of events.begin) {
      const otherBody = event.other.parent;
      if (otherBody?.get(Player)) {
        console.log("player entered checkpoint", checkpointShape.eid);
      }
    }
  });
```

The checkpoint shape is the sensor (`Sensor` + `SensorEvents`). The player's
shape adds `Detectable` so the checkpoint can see it — without the player
shape becoming a sensor or collecting its own `SensorEvents`.

## Hit Events

Hit events report high-speed impacts. Use them for damage, impact sounds, particles, or screen shake.

The default `hitEventThreshold` is `1.0` meter per second. Lower it to receive softer impacts; raise it to report only harder hits.

```ts
export type HitEvent = {
  other: Entity;
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  speed: number;
};
```

Fields:

| Field                | Meaning                                 |
| -------------------- | --------------------------------------- |
| `other`              | Other shape entity involved in the hit. |
| `x`, `y`             | Impact point in world coordinates.      |
| `normalX`, `normalY` | Contact normal.                         |
| `speed`              | Approach speed, in meters per second.   |

Example: damage a body when it hits something hard.

```ts
class Health {
  value = 100;
}

world
  .system("ImpactDamage")
  .with({ all: [{ parent: Health }, HitEvents] })
  .update(HitEvents, (shape, events) => {
    const body = shape.parent;
    const health = body?.getMut(Health);
    if (!health) return;

    for (const hit of events.hits) {
      if (hit.speed > 8) {
        health.value -= Math.round(hit.speed);
      }
    }
  });
```

## Event Lifetime

Event arrays are frame-local.

At each physics step, `vecs-physics` clears event arrays before writing new events.

If new events arrive, physics calls `entity.modified(EventComponent)`, so Vecs systems listening with `.update(...)` run.

If a previous step had events and the next step has none, physics clears the arrays silently and does not call `modified`. No event means no update.

This keeps systems quiet when nothing happened.

Sleeping bodies do not produce new contact, hit, or sensor events while they remain undisturbed. Forces, impulses, teleports, kinematic targets, or new contacts can wake them according to the `Sleep` component and `enableSleep` option.

Continuous collision detection feeds the normal contact and hit event path. A fast `Body` with `bullet: true` can generate begin/contact/hit events after the CCD step, but sensor time-of-impact hits are intentionally deferred to v2; sensor events use the regular overlap pass in v1.

## Querying Event Shapes

Because events are components, you can query for exactly the shapes that care about them.

All contact-listening shapes:

```ts
world
  .system("AllContactListeners")
  .with(ContactEvents)
  .update(ContactEvents, (shape, events) => {
    // shape has ContactEvents
  });
```

Only contact-listening shapes whose parent body is a player:

```ts
world
  .system("PlayerContacts")
  .with({ all: [{ parent: Player }, ContactEvents] })
  .update(ContactEvents, (shape, events) => {
    // shape belongs to a body with Player
  });
```

Only sensor shapes:

```ts
world
  .system("SensorListeners")
  .with(Sensor, SensorEvents)
  .update(SensorEvents, (shape, events) => {
    // shape is a sensor and receives sensor events
  });
```

## Body References

Event payloads include the other shape entity.

```ts
export type ContactEvent = {
  other: Entity;
};
```

Get the body from `event.other.parent` because shape entities are immediate children of body entities.

## Common Mistakes

### Adding Events To The Body Instead Of The Shape

Events are read and written on shape entities.

This does not receive contact events:

```ts
body.add(ContactEvents);
```

This does:

```ts
shape.set(ChildOf, { target: body }).add(ContactEvents);
```

### Forgetting Sensor On Sensor Triggers

`SensorEvents` only describe overlap events. Add `Sensor` when you want trigger behavior without collision response.

```ts
shape.add(Sensor).add(SensorEvents);
```

### Forgetting Detectable On Solid Shapes

A sensor only reports an overlap when the visited shape opts in too. A plain
solid shape (no `Detectable`, no `SensorEvents`) is invisible to every sensor,
even if the sensor shape itself has `Sensor` + `SensorEvents`.

```ts
// The sensor never sees this shape:
playerShape.set(Box, { hx: 0.5, hy: 0.5 });

// Add Detectable so sensors can see it:
playerShape.add(Detectable);
```

Do not "fix" this by adding `SensorEvents` to the solid shape — that works
mechanically (it also opts the shape in), but it implies the solid shape
receives sensor events, which it never does as a non-sensor. Use `Detectable`.

### Expecting Empty Events To Trigger Updates

Physics does not call `modified(ContactEvents)` just because an event array became empty. Systems run when new events arrive.

If you need persistent overlap state, store it in your own component and update it from `begin` and `end` events.

### Mutating Event Arrays As State

Event arrays are owned by physics and reused. Treat them as read-only during your systems. Copy data into your own component if it needs to last beyond the current update.

## Related Pages

- [Shapes](./shapes.md)
- [Bodies](./bodies.md)
- [Systems And Phases](./systems-and-phases.md)
- [Debug Validation](./debug-validation.md)
