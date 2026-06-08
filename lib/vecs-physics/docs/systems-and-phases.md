# Systems And Phases

This page explains how `vecs-physics` installs itself into a Vecs world, which phases it uses, how physics steps are ordered, and what user systems should expect before and after physics runs.

## Summary

`vecs-physics` preloads its WASM backend, then installs before `world.start()`.

```ts
await preloadPhysics();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

By default, `installPhysics` registers physics components, configures shape exclusivity, creates physics phases, and installs internal systems. Advanced users can pass custom phase entities or phase names to place physics inside an existing pipeline.

`vecs-physics` assumes the `delta` passed to `world.progress(now, delta)` is fixed. It does not run a catch-up accumulator by default.

## Core Concepts

Vecs runs systems through a query-driven pipeline. Systems default to `vecs::OnUpdate`; call `system.phase(phaseNameOrEntity)` only when a system must run somewhere else. Systems tied to the same phase run in entity id order, which normally matches creation order.

Physics needs several ordered steps:

1. Read ECS changes and update the internal Box2D world.
2. Apply forces, torques, impulses, velocity changes, teleports, and kinematic targets.
3. Step the physics simulation.
4. Write simulation results back to ECS components.
5. Publish contact, hit, and sensor events to event components.

`installPhysics` wires these steps into Vecs systems so user code can stay ECS-native.

## Minimal Setup

```ts
import { World } from "@vworlds/vecs";
import { installPhysics, preloadPhysics } from "@vworlds/vecs-physics";

const world = new World();

await preloadPhysics();

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

Vecs creates these built-in pipeline anchors: `vecs::OnLoad`, `vecs::PostLoad`, `vecs::PreUpdate`, `vecs::OnUpdate`, `vecs::OnValidate`, `vecs::PostUpdate`, `vecs::PreStore`, and `vecs::OnStore`.

By default, `installPhysics` creates and uses three additional phase entities ordered after `vecs::OnUpdate`:

| Phase          | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `physics-pre`  | Read ECS changes and prepare the physics world. |
| `physics-step` | Step the simulation.                            |
| `physics-post` | Write results and events back to ECS.           |

Conceptually, the default frame is driven by the world's pipeline query:

```ts
world.progress(now, delta);
```

Most projects can use `world.progress(now, delta)` and let Vecs run systems in dependency order.

## Custom Phase Placement

If your app already has phase entities, pass phase names or entities to `installPhysics`. Use the built-in anchors for common app work: input and gameplay systems usually stay in the default `vecs::OnUpdate`, while systems that need final physics results should target `physics-post` or a custom phase after it.

```ts
const gameplay = world
  .entity("gameplay")
  .add(Phase)
  .set(DependsOn, { target: world.entity(ON_UPDATE) });
const physicsPre = world.entity("physics-pre").add(Phase).set(DependsOn, { target: gameplay });
const physicsStep = world.entity("physics-step").add(Phase).set(DependsOn, { target: physicsPre });
const physicsPost = world.entity("physics-post").add(Phase).set(DependsOn, { target: physicsStep });
const render = world.entity("render").add(Phase).set(DependsOn, { target: physicsPost });

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
vecs::PreUpdate -> vecs::OnUpdate -> physics-pre -> physics-step -> physics-post -> render
```

In this layout:

- Input systems write movement intent, forces, impulses, or kinematic targets.
- Gameplay systems can create bodies and shapes before physics runs.
- Physics reads those changes and steps the simulation.
- Post-physics systems can react to contacts, hits, sensors, and final positions.
- Rendering reads final `Position` and `Rotation`.

Example:

```ts
const gameplay = world
  .entity("gameplay")
  .add(Phase)
  .set(DependsOn, { target: world.entity(ON_UPDATE) });
const physicsPre = world.entity("physics-pre").add(Phase).set(DependsOn, { target: gameplay });
const physicsStep = world.entity("physics-step").add(Phase).set(DependsOn, { target: physicsPre });
const physicsPost = world.entity("physics-post").add(Phase).set(DependsOn, { target: physicsStep });
const render = world.entity("render").add(Phase).set(DependsOn, { target: physicsPost });

installPhysics(world, {
  preStepPhase: physicsPre,
  stepPhase: physicsStep,
  postStepPhase: physicsPost,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

const inputSystem = world
  .system("ApplyPlayerInput")
  .with(PlayerInput, Body)
  .update(PlayerInput, (entity, input) => {
    if (input.jumpPressed) {
      entity.set(Impulse, { x: 0, y: 8 });
    }
  });

const contactSystem = world
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

## World Options

`installPhysics` applies Box2D-aligned defaults when options are omitted.

| Option                 |            Default | Description                                                             |
| ---------------------- | -----------------: | ----------------------------------------------------------------------- |
| `gravity`              | `{ x: 0, y: -10 }` | World gravity in meters per second squared.                             |
| `fixedTimeStep`        |           `1 / 60` | Physics step size in seconds.                                           |
| `subSteps`             |                `4` | Solver substeps per physics step.                                       |
| `debug`                |            `false` | Installs debug validation and fixed-delta warnings when `true`.         |
| `restitutionThreshold` |              `1.0` | Speed below which restitution is suppressed.                            |
| `hitEventThreshold`    |              `1.0` | Minimum impact speed for `HitEvents`.                                   |
| `contactHertz`         |               `30` | Contact softness frequency before the per-substep Box2D clamp.          |
| `contactDampingRatio`  |               `10` | Contact damping ratio.                                                  |
| `contactSpeed`         |              `3.0` | Contact speed threshold used by contact event classification.           |
| `maximumLinearSpeed`   |              `400` | Maximum linear speed in meters per second.                              |
| `enableSleep`          |             `true` | Allows inactive bodies with `Sleep.enabled` to move into sleeping sets. |
| `enableContinuous`     |             `true` | Enables continuous collision for bullet and fast-body paths.            |

When `debug` is `true`, `PhysicsDebugValidation` runs at the end of `physics-pre`; otherwise that system is not installed. When `enableContinuous` is `true`, the step can run the CCD path for `Body.bullet` and other fast bodies before events are published.

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

## Pipeline Driving

Keep phase entities ordered through `DependsOn`, place systems with `.phase(...)` when they need a non-default phase, and drive the frame with `world.progress(now, delta)`. Do not place `physics-step` before `physics-pre`, and do not read physics results before `physics-post`.

## Common Use Cases

### Apply Impulses From Input

Input should usually run before physics.

```ts
const jump = world
  .system("Jump")
  .with(PlayerInput, Body)
  .update(PlayerInput, (entity, input) => {
    if (input.jumpPressed) {
      entity.set(Impulse, { x: 0, y: 8 });
    }
  });
```

The impulse is queued from the default `vecs::OnUpdate` phase and applied before the next physics step.

### Render Final Positions

Rendering should read positions after physics.

```ts
const renderSprites = world
  .system("RenderSprites")
  .phase("physics-post")
  .with(Position, Sprite)
  .each([Position, Rotation, Sprite], (_entity, [position, rotation, sprite]) => {
    sprite.x = position.x;
    sprite.y = position.y;
    sprite.rotation = rotation?.angle ?? 0;
  });
```

Place render systems at `physics-post` or a custom render phase after it so sprites see final simulated positions.

### React To Contacts

Contact reactions should run after physics has published events.

```ts
const damage = world
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

Physics systems must be installed before `world.start()` so they participate in the pipeline.

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
