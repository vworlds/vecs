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

world
  .system("CheckpointTriggers")
  .query({ all: [Checkpoint, SensorEvents] })
  .update(SensorEvents, (checkpointShape, events) => {
    for (const event of events.begin) {
      const otherBody = event.other.parent(ChildOf);
      if (otherBody?.get(Player)) {
        console.log("player entered checkpoint", checkpointShape.eid);
      }
    }
  });
```

Sensor event payloads follow the same basic shape as contact events.

```ts
export type SensorEvent = {
  other: Entity;
};
```

`other` is the other shape entity involved in the overlap.

## Hit Events

Hit events report high-speed impacts. Use them for damage, impact sounds, particles, or screen shake.

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
  .query({ all: [{ parent: Health }, HitEvents] })
  .update(HitEvents, (shape, events) => {
    const body = shape.parent(ChildOf);
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

## Querying Event Shapes

Because events are components, you can query for exactly the shapes that care about them.

All contact-listening shapes:

```ts
world
  .system("AllContactListeners")
  .requires(ContactEvents)
  .update(ContactEvents, (shape, events) => {
    // shape has ContactEvents
  });
```

Only contact-listening shapes whose parent body is a player:

```ts
world
  .system("PlayerContacts")
  .query({ all: [{ parent: Player }, ContactEvents] })
  .update(ContactEvents, (shape, events) => {
    // shape belongs to a body with Player
  });
```

Only sensor shapes:

```ts
world
  .system("SensorListeners")
  .requires(Sensor, SensorEvents)
  .update(SensorEvents, (shape, events) => {
    // shape is a sensor and receives sensor events
  });
```

## Optional Body References

Event payloads always include the other shape entity.

Implementations may also include the other body entity when it is already available at no meaningful cost.

```ts
export type ContactEvent = {
  other: Entity;
  otherBody?: Entity;
};
```

Do not require `otherBody` in portable code. You can always get the body from `event.other.parent(ChildOf)` because shape entities are immediate children of body entities.

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
