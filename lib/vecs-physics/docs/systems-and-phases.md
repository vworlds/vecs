# Systems And Phases

This page explains how `vecs-physics` installs itself into a Vecs world, which phases it uses, how physics steps are ordered, and what user systems should expect before and after physics runs.

## Summary

`vecs-physics` is installed before `world.start()`.

```ts
installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

By default, `installPhysics` registers physics components, configures shape exclusivity, creates physics phases, and installs internal systems. Advanced users can pass custom phases or phase names to place physics inside an existing pipeline.

`vecs-physics` assumes the `delta` passed to `world.progress(now, delta)` is fixed. It does not run a catch-up accumulator by default.

## Core Concepts

Vecs runs systems inside named phases. Phases run in registration order, and systems inside a phase run in system registration order.

Physics needs several ordered steps:

1. Read ECS changes and update internal physics state.
2. Apply forces, torques, impulses, velocity changes, teleports, and kinematic targets.
3. Step the physics simulation.
4. Write simulation results back to ECS components.
5. Publish contact, hit, and sensor events to event components.

`installPhysics` wires these steps into Vecs systems so user code can stay ECS-native.

## Minimal Setup

```ts
import { World } from "@vworlds/vecs";
import { installPhysics } from "@vworlds/vecs-physics";

const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

world.start();

// Use a fixed delta. 1000 / 60 ms corresponds to 1 / 60 seconds.
world.progress(performance.now(), 1000 / 60);
```

Use the default setup when you do not need special ordering around physics.

## Default Phases

By default, `installPhysics` creates and uses three phases:

| Phase          | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `physics-pre`  | Read ECS changes and prepare the physics world. |
| `physics-step` | Step the simulation.                            |
| `physics-post` | Write results and events back to ECS.           |

Conceptually, the default frame looks like this:

```ts
world.beginFrame(delta);
try {
  world.runPhase(physicsPre, now, delta);
  world.runPhase(physicsStep, now, delta);
  world.runPhase(physicsPost, now, delta);
} finally {
  world.endFrame();
}
```

Most projects can use `world.progress(now, delta)` and let Vecs run phases in registration order.

## Custom Phase Placement

If your app already has phases, pass phase names or phase objects to `installPhysics`.

```ts
const input = world.addPhase("input");
const gameplay = world.addPhase("gameplay");
const physicsPre = world.addPhase("physics-pre");
const physicsStep = world.addPhase("physics-step");
const physicsPost = world.addPhase("physics-post");
const render = world.addPhase("render");

installPhysics(world, {
  preStepPhase: physicsPre,
  stepPhase: physicsStep,
  postStepPhase: physicsPost,
});
```

Or use phase names:

```ts
installPhysics(world, {
  preStepPhase: "physics-pre",
  stepPhase: "physics-step",
  postStepPhase: "physics-post",
});
```

Use custom placement when input, gameplay, camera, animation, networking, or rendering systems need strict ordering relative to physics.

## Recommended Frame Ordering

A common game loop looks like this:

```text
input -> gameplay -> physics-pre -> physics-step -> physics-post -> render
```

In this layout:

- Input systems write movement intent, forces, impulses, or kinematic targets.
- Gameplay systems can create bodies and shapes before physics runs.
- Physics reads those changes and steps the simulation.
- Post-physics systems can react to contacts, hits, sensors, and final positions.
- Rendering reads final `Position` and `Rotation`.

Example:

```ts
const input = world.addPhase("input");
const gameplay = world.addPhase("gameplay");
const physicsPre = world.addPhase("physics-pre");
const physicsStep = world.addPhase("physics-step");
const physicsPost = world.addPhase("physics-post");
const render = world.addPhase("render");

installPhysics(world, {
  preStepPhase: physicsPre,
  stepPhase: physicsStep,
  postStepPhase: physicsPost,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

world
  .system("ApplyPlayerInput")
  .phase(input)
  .requires(PlayerInput, Body)
  .update(PlayerInput, (entity, input) => {
    if (input.jumpPressed) {
      entity.set(Impulse, { x: 0, y: 8 });
    }
  });

world
  .system("ReactToContacts")
  .phase(physicsPost)
  .update(ContactEvents, (shapeEntity, events) => {
    for (const event of events.begin) {
      // Runs after physics has published contact events.
      console.log("contact", shapeEntity.eid, event.other.eid);
    }
  });

world.start();
```

## Fixed Timestep Assumption

Box2D-style physics is designed for fixed timesteps. `vecs-physics` follows that model.

`fixedTimeStep` is expressed in seconds:

```ts
installPhysics(world, {
  fixedTimeStep: 1 / 60,
});
```

Vecs `delta` is expressed in milliseconds:

```ts
world.progress(now, 1000 / 60);
```

`vecs-physics` assumes these agree. It does not automatically turn variable render deltas into multiple fixed simulation steps.

If your renderer has variable frame timing, use a fixed-step loop outside Vecs and call `world.progress` with a fixed delta for each simulation tick.

```ts
const fixedDeltaMs = 1000 / 60;

function tick(now: number) {
  world.progress(now, fixedDeltaMs);
}
```

## Sub-Steps

`subSteps` controls solver accuracy inside each physics step.

```ts
installPhysics(world, {
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

The default recommendation is `4`, matching Box2D guidance.

Higher values improve stability for difficult constraints and fast interactions, but cost more CPU. Lower values are faster but less accurate.

For the first version of `vecs-physics`, joints are deferred, so most projects should start with `4` and only tune if contacts feel unstable.

## What Runs Before The Step

Before stepping, physics systems consume ECS changes such as:

- New or removed `Body` components.
- New, removed, or changed shape geometry components.
- `Position` and `Rotation` changes that should teleport bodies.
- `LinearVelocity` and `AngularVelocity` changes.
- Persistent `Force` and `Torque` components.
- Queued `Impulse` and `AngularImpulse` updates.
- `KinematicTargetPosition` and `KinematicTargetRotation` components.
- `Material` and `CollisionFilter` changes.

Write these components before the physics phases if you want the changes to affect the current step.

## What Runs After The Step

After stepping, physics writes results back to ECS:

- Dynamic body `Position` and `Rotation` are updated from simulation output.
- `LinearVelocity` and `AngularVelocity` are updated when those components are present.
- `ContactEvents`, `HitEvents`, and `SensorEvents` are filled and marked modified when new events arrive.
- Consumed `Impulse` and `AngularImpulse` public fields are silently reset to zero.

Run gameplay systems that react to final physics results after `physics-post`.

## Manual Phase Driving

If you manually drive phases, keep physics phases in order.

```ts
world.beginFrame(1000 / 60);
try {
  world.runPhase(input, now, 1000 / 60);
  world.runPhase(gameplay, now, 1000 / 60);
  world.runPhase(physicsPre, now, 1000 / 60);
  world.runPhase(physicsStep, now, 1000 / 60);
  world.runPhase(physicsPost, now, 1000 / 60);
  world.runPhase(render, now, 1000 / 60);
} finally {
  world.endFrame();
}
```

Do not run `physics-step` without `physics-pre`, and do not read physics results before `physics-post`.

## Common Use Cases

### Apply Impulses From Input

Input should usually run before physics.

```ts
world
  .system("Jump")
  .phase("input")
  .requires(PlayerInput, Body)
  .update(PlayerInput, (entity, input) => {
    if (input.jumpPressed) {
      entity.set(Impulse, { x: 0, y: 8 });
    }
  });
```

The impulse is queued and applied before the next physics step.

### Render Final Positions

Rendering should read positions after physics.

```ts
world
  .system("RenderSprites")
  .phase("render")
  .requires(Position, Sprite)
  .each([Position, Rotation, Sprite], (_entity, [position, rotation, sprite]) => {
    sprite.x = position.x;
    sprite.y = position.y;
    sprite.rotation = rotation?.angle ?? 0;
  });
```

Place `render` after `physics-post` so sprites see final simulated positions.

### React To Contacts

Contact reactions should run after physics has published events.

```ts
world
  .system("DamageOnHit")
  .phase("physics-post")
  .update(ContactEvents, (shapeEntity, events) => {
    for (const event of events.begin) {
      const body = shapeEntity.parent(ChildOf);
      const otherBody = event.other.parent(ChildOf);

      if (body?.get(Player) && otherBody?.get(Enemy)) {
        body.set(Health, { hp: body.get(Health)!.hp - 1 });
      }
    }
  });
```

## Gotchas

### `installPhysics` Must Run Before `world.start()`

Vecs disables component registration after `world.start()`. Physics components and systems must be installed before then.

```ts
installPhysics(world);
world.start();
```

This is wrong:

```ts
world.start();
installPhysics(world); // too late
```

### Variable Delta Produces Variable Physics

Do not pass render-frame delta directly if it varies.

```ts
world.progress(now, frameDeltaMs); // bad if frameDeltaMs changes every frame
```

Use a fixed simulation delta.

```ts
world.progress(now, 1000 / 60);
```

### Phase Order Determines Winners

If user code writes `Position` after physics, rendering will see the user-written position. Physics will interpret that write as a teleport before the next step.

If user code writes `Position` before physics, physics may step from that teleported position and then write the simulated result back.

This is intentional. It follows Vecs phase ordering.

### Events Are One-Step Data

Event arrays are cleared every physics step.

If new events arrive, physics calls `modified` on the event component. If no new events arrive, physics stays silent even if it cleared old event data.

Systems that care about contacts should process event updates when they happen, not assume event arrays are persistent state.

### Child Effects Only Check One Parent

Forces, torques, impulses, and angular impulses can live on a body entity or on an immediate child of a body entity.

Physics does not search grandparents.

```ts
// Applies to player.
world.entity().set(ChildOf, { target: player }).set(Force, { x: 1, y: 0 });

// Does not apply unless tractorBeam itself has Body.
world.entity().set(ChildOf, { target: tractorBeam }).set(Force, { x: 1, y: 0 });
```

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Kinematic Motion](./kinematic-motion.md)
- [Debug Validation](./debug-validation.md)
