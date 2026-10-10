# Systems And Phases

This page explains how `vecs-physics` registers itself in a Vecs world, which phases it uses, how physics steps are ordered, and what user systems should expect before and after physics runs.

## Summary

`vecs-physics` preloads its WASM backend, then registers `PhysicsModule` in a world.

```ts
await preloadPhysics();

world.module(PhysicsModule, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

By default, `PhysicsModule` registers physics components, configures shape exclusivity, creates physics phases, and registers internal systems. Advanced users can pass custom phase entities or phase names to place physics inside an existing pipeline. Physics systems enter the pipeline the next time `world.progress()` runs.

`vecs-physics` assumes the `delta` passed to `world.progress(now, delta)` is fixed. It does not run a catch-up accumulator by default.

## Core Concepts

Vecs runs systems through a query-driven pipeline. Systems default to `vecs::OnUpdate`; call `system.phase(phaseNameOrEntity)` only when a system must run somewhere else. Systems tied to the same phase run in entity id order, which normally matches creation order.

Physics needs several ordered steps:

1. Read ECS changes and update the internal Box2D world.
2. Apply forces, torques, impulses, velocity changes, teleports, and kinematic targets.
3. Step the physics simulation.
4. Write simulation results back to ECS components.
5. Publish contact, hit, and sensor events to event components.

`PhysicsModule` wires these steps into Vecs systems so user code can stay ECS-native.

## Minimal Setup

```ts
import { World } from "@vworlds/vecs";
import { PhysicsModule, preloadPhysics } from "@vworlds/vecs-physics";

const world = new World();

await preloadPhysics();

world.module(PhysicsModule, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

// Use a fixed delta. 1000 / 60 ms corresponds to 1 / 60 seconds.
world.progress(performance.now(), 1000 / 60);
```

Use the default setup when you do not need special ordering around physics.

## Default Phases

Vecs creates these built-in pipeline anchors: `vecs::OnLoad`, `vecs::PostLoad`, `vecs::PreUpdate`, `vecs::OnUpdate`, `vecs::OnValidate`, `vecs::PostUpdate`, `vecs::PreStore`, and `vecs::OnStore`.

By default, `PhysicsModule` creates three configurable physics phases and an internal cleanup phase ordered after `vecs::OnUpdate`:

| Phase             | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `physics-pre`     | Read ECS changes and prepare the physics world.              |
| `physics-cleanup` | Remove queued Box2D resources and recompute mass (internal). |
| `physics-step`    | Step the simulation.                                         |
| `physics-post`    | Write results and events back to ECS.                        |

Conceptually, the default frame is driven by the world's pipeline query:

```ts
world.progress(now, delta);
```

Most projects can use `world.progress(now, delta)` and let Vecs run systems in dependency order.

Destroying an entity in the default phase or anywhere in `physics-pre` removes its body
before the next simulation step, independent of system registration order. Lifecycle queries
enqueue teardown at the structural-change flush; `PhysicsReaper` performs Box2D removal in
`physics-cleanup`, after all pre-step systems. It clears reverse-index entries as it frees
resources, then `PhysicsMassRecompute` updates the remaining bodies' mass.

Destroying an entity in `physics-post` is also safe, including before pose writeback:
`PhysicsPoseSyncOut` skips move events for destroyed entities. That body already participated
in the current step and is removed before the following step. Custom phase names retain the
internal cleanup boundary. If you insert a phase after `physics-pre` with `insertPhaseAfter`,
it runs ahead of cleanup and its destroys are also removed before stepping. Keep application
systems out of the internal cleanup phase.

## Custom Phase Placement

If your app already has phase entities, pass phase names or entities to `PhysicsModule`. Use the built-in anchors for common app work: input and gameplay systems usually stay in the default `vecs::OnUpdate`, while systems that need final physics results should target `physics-post` or a custom phase after it.

```ts
const gameplay = world.entity("gameplay").add(Phase).add(DependsOn, world.entity(ON_UPDATE));
const physicsPre = world.entity("physics-pre").add(Phase).add(DependsOn, gameplay);
const physicsStep = world.entity("physics-step").add(Phase).add(DependsOn, physicsPre);
const physicsPost = world.entity("physics-post").add(Phase).add(DependsOn, physicsStep);
const render = world.entity("render").add(Phase).add(DependsOn, physicsPost);

world.module(PhysicsModule, {
  preStepPhase: physicsPre,
  stepPhase: physicsStep,
  postStepPhase: physicsPost,
});
```

Or use phase names:

```ts
world.module(PhysicsModule, {
  preStepPhase: "physics-pre",
  stepPhase: "physics-step",
  postStepPhase: "physics-post",
});
```

Use custom placement when input, gameplay, camera, animation, networking, or rendering systems need strict ordering relative to physics.

## Recommended Frame Ordering

A common game loop looks like this:

```text
vecs::PreUpdate -> vecs::OnUpdate -> physics-pre -> physics-cleanup -> physics-step -> physics-post -> render
```

In this layout:

- Input systems write movement intent, forces, impulses, or kinematic targets.
- Gameplay systems can create bodies and shapes before physics runs.
- Physics reads those changes and steps the simulation.
- Post-physics systems can react to contacts, hits, sensors, and final positions.
- Rendering reads final `Position` and `Rotation`.

Example:

```ts
const gameplay = world.entity("gameplay").add(Phase).add(DependsOn, world.entity(ON_UPDATE));
const physicsPre = world.entity("physics-pre").add(Phase).add(DependsOn, gameplay);
const physicsStep = world.entity("physics-step").add(Phase).add(DependsOn, physicsPre);
const physicsPost = world.entity("physics-post").add(Phase).add(DependsOn, physicsStep);
const render = world.entity("render").add(Phase).add(DependsOn, physicsPost);

world.module(PhysicsModule, {
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
```

## Fixed Timestep Assumption

Box2D-style physics is designed for fixed timesteps. `vecs-physics` follows that model.

`fixedTimeStep` is expressed in seconds:

```ts
world.module(PhysicsModule, {
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
world.module(PhysicsModule, {
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

The default recommendation is `4`, matching Box2D guidance.

Higher values improve stability for difficult constraints and fast interactions, but cost more CPU. Lower values are faster but less accurate.

Joints and contacts use the same world substep count, so most projects should start with `4` and
only tune if constraints or contacts feel unstable.

## World Options

`PhysicsModule` applies Box2D-aligned defaults when options are omitted.

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

When `debug` is `true`, `PhysicsDebugValidation` runs at the end of `physics-pre`; otherwise that system is not registered. When `enableContinuous` is `true`, the step can run the CCD path for `Body.bullet` and other fast bodies before events are published.

## What Runs Before The Step

Before stepping, physics systems consume ECS changes such as:

- New or removed `Body` components.
- New, removed, or changed shape geometry components.
- New or removed joints, and joint feature (motor/limit/spring) changes.
- `Position` and `Rotation` changes that should teleport bodies.
- `LinearVelocity` and `AngularVelocity` changes.
- Persistent `Force` and `Torque` components.
- Queued `Impulse` and `AngularImpulse` updates.
- `KinematicTargetPosition` and `KinematicTargetRotation` components.
- `Material` and `CollisionFilter` changes.

Write these components before the physics phases if you want the changes to affect the current step.

## What Runs After The Step

After stepping, physics writes results back to ECS:

- Dynamic body `Position` and `Rotation` are updated from simulation output, but only when their value changed.
- `LinearVelocity` and `AngularVelocity` are updated when those components are present, again only when their value changed. See [Pose Updates Fire Only When The Pose Changes](#pose-updates-fire-only-when-the-pose-changes).
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
      const body = shapeEntity.parent;
      const otherBody = event.other.parent;

      if (body?.get(Player) && otherBody?.get(Enemy)) {
        body.set(Health, { hp: body.get(Health)!.hp - 1 });
      }
    }
  });
```

## Gotchas

### Install The Module Before Creating Physics Entities

`PhysicsModule` registers the physics component classes (`Body`, `Box`, `Position`, …) when it is installed. Install it before you add any of those components to entities — adding one beforehand throws because the class is not registered on the world yet.

```ts
world.module(PhysicsModule); // registers physics components and systems
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });
```

Physics wires entities through reactive systems that only observe components added on or after install, so there is no backfill of entities created before the module. This is by design: install the module first, the same way you install an operating system before running programs. See [Installation](./installation.md#install-the-module-before-creating-physics-entities).

### Systems Join On The Next Progress

Physics systems enter the pipeline starting with the next `world.progress()` call after install. Installing on an existing world is fine; it simply cannot affect frames that already ran.

```ts
world.progress(performance.now(), 1000 / 60);
world.module(PhysicsModule); // active on the next progress
world.progress(performance.now(), 1000 / 60);
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

### Pose Updates Fire Only When The Pose Changes

Box2D reports every awake dynamic body after every step, and a body that did not move or turn reports exactly the values it already had. Writing a component marks it modified: its `set` hooks fire, every system watching it with `.update(...)` runs, and a networked component is replicated to every client that sees the entity. So physics compares each pose component with the simulated value, field by field and with exact equality (no epsilon), and writes it only when at least one field differs.

- A body flying in a straight line gets a new `Position` every step, but its `Rotation` and `AngularVelocity` are not rewritten, so a constant `Rotation` is not replicated either.
- An awake body at rest, for example one with `Sleep.enabled = false`, gets no pose write at all.
- A body that moves and turns still gets exactly one write per changed component per step. `LinearVelocity` is one component: a change in either field writes it once.
- `Position` is created by the first write when the body has none. `Rotation`, `LinearVelocity` and `AngularVelocity` are only maintained on bodies that already carry them.
- Box2D stores positions as 32-bit floats and a rotation as a cosine and sine pair, so the first step can still rewrite a component whose initial value Box2D does not reproduce exactly, such as a position of `0.1` or an angle of `0.3`. After that the value is stable.

A system that waits for `update(Position)` therefore runs when the body actually moved, not on every step. If a system must visit every body on every step, iterate with `each` and read the component instead of waiting for a modification. `each` visits every matching body, asleep or awake, so it cannot tell you which bodies are awake:

```ts
world
  .system("LogAltitude")
  .with(Body, Position)
  .each([Position], (_entity, [position]) => {
    console.log(position.y);
  });
```

### Events Are One-Step Data

Event arrays are cleared every physics step.

If new events arrive, physics calls `modified` on the event component. If no new events arrive, physics stays silent even if it cleared old event data.

Systems that care about contacts should process event updates when they happen, not assume event arrays are persistent state.

### Child Effects Only Check One Parent

Forces, torques, impulses, and angular impulses can live on a body entity or on an immediate child of a body entity.

Physics does not search grandparents.

```ts
// Applies to player.
world.entity().add(ChildOf, player).set(Force, { x: 1, y: 0 });

// Does not apply unless tractorBeam itself has Body.
world.entity().add(ChildOf, tractorBeam).set(Force, { x: 1, y: 0 });
```

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Kinematic Motion](./kinematic-motion.md)
- [Debug Validation](./debug-validation.md)
