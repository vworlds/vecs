# Joints

Joints connect two bodies with a constraint: a hinge, a rod, a rigid weld. In
`vecs-physics` a joint is its own entity that references two body entities and
carries one joint-type component plus optional feature components. This page
covers what you'll learn: how to create a joint, how the connection and anchor
frame work, the available joint types, how to add motors/limits/springs, and the
lifecycle rules.

Joints follow the same Vecs-first model as the rest of the package: you describe
the joint with components, and physics reacts to their presence and changes. You
never touch a Box2D joint handle.

## Creating a joint

A joint entity needs two exclusive relationship slots — `JointBodyA` and
`JointBodyB` — pointing at the connected body entities, and exactly one
joint-type component. `JointsModule` configures each slot as `Exclusive`, so
adding the same relationship with a different body replaces its target:

```ts
import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  DistanceJoint,
  JointBodyA,
  JointBodyB,
  Position,
  PhysicsModule,
  preloadPhysics,
} from "@vworlds/vecs-physics";

await preloadPhysics();
const world = new World();
world.module(PhysicsModule);

const anchor = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 5 });
const bob = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 2, y: 5 });
world.entity().childOf(bob).set(Box, { hx: 0.5, hy: 0.5 });

world.entity().add(JointBodyA, anchor).add(JointBodyB, bob).set(DistanceJoint, { length: 2 });
```

Creation is **order-independent**: a joint forms as soon as both connected
entities carry a `Body`, no matter whether the joint or the bodies were created
first. The body roles are asymmetric — motors drive body B relative to body A,
and the reference angle is measured as B's rest angle relative to A.

### Initialize and move the whole assembly

Create joints with the bodies already at their intended assembly rest pose. Before
the next physics step, move every connected body together when teleporting an
assembly. Preserve or reset **every body's** `LinearVelocity` and `AngularVelocity`
consistently too; changing `Position` does not reset velocity. For rotated
assemblies, update body rotations, positions and velocities consistently.

Box2D 3.2 applies its speed clamp after the biased constraint solve, unlike 3.1.
A joint created far from its rest pose can therefore leave residual motion when
the correction hits the speed limit. Teleporting the bodies back into place and
resetting only one velocity leaves the other body moving: the assembly swings.
See the existing [`maximumLinearSpeed` lever](./systems-and-phases.md#world-options)
before trying to compensate with stiffness or more substeps.

Measure **anchor distance**, not just an x- or y-offset. For example, a length-1
rigid distance joint with origin anchors, initialized far from rest at 30 Hz / four
substeps, then teleported to rest with only one velocity reset, produced an
x-offset of about **0.912 m** and a y-offset of **−0.423 m** under 7.0.0. The actual
distance was about **1.005 m**, not 0.912 m. Creating the joint at rest, or resetting
both velocities after the teleport, held the distance at 1 m without that swing.
The component-level characterization lives in
[`tests/joints/initialization.test.ts`](../tests/joints/initialization.test.ts).

### Constraint softness and the 3.2 migration

Base constraint tuning defaults to **60 Hz / damping ratio 2** in both the Box2D
revision bundled with WASM 6.0.1 and Box2D 3.2 bundled with 7.0.0. The softness
calculation and frequency cap are unchanged: with substep duration
`h = fixedTimeStep / subSteps`, the effective frequency is
`min(60, 0.25 / h)`. At 1/60 s with four substeps this is 60 Hz; at 1/30 s with
four substeps it is 30 Hz. There is no different legacy stiffness preset to restore.
vecs-physics does not expose a base constraint-tuning component or world option.

Use `JointLinearSpring` or `JointAngularSpring` when you intentionally want a
spring. These features use their **own frequency and damping**, independently of
base constraint softness; adding a distance spring replaces the rigid rod's
response along its axis. In particular, base tuning would not retune a distance
spring's own stiffness. `FilterJoint` has no physical constraint; `MotorJoint`
uses its own velocity and spring fields.

Do not infer changed stiffness from a changed collision trajectory. Box2D 3.2
also changes contact recycling, the contact push pass and restitution. Those
changes can alter a spring-linked train's impact response without changing its
spring settings. Neither a new stiffness preset nor more substeps guarantees
3.1 trajectories; review your application's handling separately. See
[contact timing](./events.md#contact-timing-in-box2d-32) for the measured recycling
effect, not an exclusive diagnosis of a game's ten-second impact trajectory.

Reference comparison: Box2D
[`3a4f0da` joint defaults and preparation](https://github.com/erincatto/box2d/blob/3a4f0da8374af61293a03021c9a0b3ebcfe67948/src/joint.c)
and [`178495b`](https://github.com/erincatto/box2d/blob/178495ba35695aefe9c321e569d2277f06db3b90/src/joint.c),
using `b2MakeSoft` in each revision's `src/solver.h`. Fresh 7.0.0 joint readback
confirmed 60 Hz / damping 2 for all seven supported types; this does not imply
that filter and motor joints use base softness in their solvers.

## The joint frame

Where a joint attaches on each body, and the bodies' rest orientation, is set
with the optional `JointFrame` component:

```ts
import { JointFrame, RevoluteJoint } from "@vworlds/vecs-physics";

world
  .entity()
  .add(JointBodyA, anchor)
  .add(JointBodyB, bob)
  .add(RevoluteJoint)
  .set(JointFrame, {
    localAnchorA: { x: 0, y: 0 }, // attach point in body A's local frame
    localAnchorB: { x: -1, y: 0 }, // attach point in body B's local frame
    referenceAngle: 0, // B's angle relative to A at rest (radians)
  });
```

A missing `JointFrame` anchors both bodies at their origins with a zero reference
angle. Anchors and the reference angle are fixed at creation; changing
`JointFrame` rebuilds the joint.

## Joint types

Exactly one joint-type component lives on a joint entity (they are mutually
exclusive, like geometry components). This component exclusivity is separate
from relationship cardinality: `JointBodyA` and `JointBodyB` are independently
exclusive relationship slots. This version ships seven types:

| Type             | Constraint                                                                            |
| ---------------- | ------------------------------------------------------------------------------------- |
| `RevoluteJoint`  | Hinge: pins the bodies at a shared anchor, free relative rotation.                    |
| `DistanceJoint`  | Keeps the two anchors a fixed `length` apart (a rigid rod by default).                |
| `PrismaticJoint` | Slider: locks relative rotation, lets body B slide along one axis.                    |
| `WheelJoint`     | Like `PrismaticJoint`, but leaves relative rotation free (a wheel on a suspension).   |
| `WeldJoint`      | Rigidly fixes the relative position and orientation.                                  |
| `FilterJoint`    | Disables collision between the two bodies without constraining them.                  |
| `MotorJoint`     | Drives body B toward a target pose relative to body A (velocity + spring, always on). |

`DistanceJoint` carries a `length` field, `MotorJoint` carries its own set of
velocity/spring fields (see [Motor joint](#motor-joint) below), and the rest are
markers whose behaviour is shaped by the frame and feature components.

### The sliding axis (`PrismaticJoint`, `WheelJoint`)

`PrismaticJoint` and `WheelJoint` slide body B along an axis instead of pinning
it at a point. That axis is body A's local x-axis, rotated by
`JointFrame.referenceAngle` — 0 means the axis runs along body A's own local
x-axis:

```ts
import { JointFrame, PrismaticJoint } from "@vworlds/vecs-physics";

world
  .entity()
  .add(JointBodyA, cart)
  .add(JointBodyB, piston)
  .add(PrismaticJoint)
  .set(JointFrame, { referenceAngle: Math.PI / 2 }); // slide straight up/down
```

`PrismaticJoint` additionally locks the bodies' relative angle at that same
value (like `WeldJoint`); `WheelJoint` leaves rotation completely free, so the
connected body can spin like a wheel on an axle while its suspension travels
along the axis.

### Motor joint

`MotorJoint` does not fit the shared feature model: Box2D gives it no enable
flags, so its velocity motor and positional spring are both always active. It
carries its own fields directly, the same way `DistanceJoint` carries `length`:

```ts
import { MotorJoint } from "@vworlds/vecs-physics";

world
  .entity()
  .add(JointBodyA, ground)
  .add(JointBodyB, player)
  .set(MotorJoint, {
    linearVelocity: { x: 3, y: 0 }, // drive body B at 3 m/s relative to body A
    maxVelocityForce: 200, // clamp the velocity motor's force
    linearHertz: 5, // soften the positional spring pulling B toward the frame's target
    linearDampingRatio: 0.7,
    maxSpringForce: 500,
  });
```

`JointFrame`'s anchors and `referenceAngle` set the target relative pose the
spring pulls toward. `JointMotor`, `JointLimit`, `JointLinearSpring`, and
`JointAngularSpring` do not apply to `MotorJoint`.

## Features: motor, limit, spring

Optional features are reusable components shared across joint types. **A feature
is enabled exactly when its component is present** — there is no `enableMotor`
flag. Add the component to enable and tune the feature, remove it to disable,
re-set it to retune, all independently of one another and of the joint itself.

```ts
import { JointMotor, JointLimit, JointAngularSpring } from "@vworlds/vecs-physics";

const hinge = world.entity().add(JointBodyA, anchor).add(JointBodyB, bob).add(RevoluteJoint);

hinge.set(JointMotor, { targetSpeed: 2, maxForce: 50 }); // drive the hinge
hinge.set(JointLimit, { lower: -0.5, upper: 0.5 }); // clamp the angle (radians)

hinge.remove(JointMotor); // stop driving; the hinge swings freely again
```

- `JointMotor { targetSpeed, maxForce }` — drives the joint toward `targetSpeed`,
  bounded by `maxForce`. Angular joints (revolute, wheel) interpret this as
  rad/s and a torque; linear joints (distance, prismatic) interpret it as m/s
  and a force.
- `JointLimit { lower, upper }` — an angle range (radians) for revolute, a
  length/translation range (meters) for distance, prismatic, and wheel.
- `JointLinearSpring { hertz, dampingRatio }` — a soft constraint along the
  linear axis (distance, prismatic, wheel, and the linear axis of weld).
- `JointAngularSpring { hertz, dampingRatio }` — a soft constraint on the
  relative angle (revolute, and the angular axis of weld). Split from the linear
  spring so a weld can carry both at once.

### Which features apply to which type

| Type             | Motor | Limit | Linear spring | Angular spring |
| ---------------- | :---: | :---: | :-----------: | :------------: |
| `RevoluteJoint`  |  yes  |  yes  |       —       |      yes       |
| `DistanceJoint`  |  yes  |  yes  |      yes      |       —        |
| `PrismaticJoint` |  yes  |  yes  |      yes      |       —        |
| `WheelJoint`     |  yes  |  yes  |      yes      |       —        |
| `WeldJoint`      |   —   |   —   |      yes      |      yes       |
| `FilterJoint`    |   —   |   —   |       —       |       —        |
| `MotorJoint`     |   —   |   —   |       —       |       —        |

A feature component on a type that does not support it is ignored. `MotorJoint`
has its own always-on velocity/spring fields instead — see
[Motor joint](#motor-joint).

## Letting the connected bodies collide

By default the two connected bodies do not collide with each other. Add
`JointSettings` to allow it:

```ts
import { JointSettings } from "@vworlds/vecs-physics";

joint.set(JointSettings, { collideConnected: true });
```

## Lifecycle

| ECS change                                           | Physics behavior                                                |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| Both bodies have `Body` + joint-type set             | Create the joint.                                               |
| Remove the joint-type component                      | Destroy the joint.                                              |
| Destroy the joint entity                             | Destroy the joint; bodies are unaffected.                       |
| Destroy a connected body                             | Destroy the joint entity with it; the other body is unaffected. |
| Add `JointBodyA`/`JointBodyB` with a different body  | Replace that slot's target and rebuild the joint.               |
| Change `JointFrame` / `DistanceJoint` / `MotorJoint` | Rebuild the joint with the new geometry/fields.                 |
| Add/remove/change a feature component                | Enable/disable/retune that feature, waking the bodies.          |

### Destroying a connected body

`JointsModule` gives `JointBodyA` and `JointBodyB` the `CleanupPolicy.Delete`
policy, so destroying either body destroys the joint entity too, together with
every component you attached to it yourself. This follows Box2D, which destroys a
body's joints along with the body. The other body is not affected: it only loses
the constraint. A body that several joints connect to takes all of them with it,
so you never have to cascade joint cleanup by hand, for example with `ChildOf`.

```ts
const joint = world
  .entity()
  .add(JointBodyA, anchor)
  .add(JointBodyB, bob)
  .set(DistanceJoint, { length: 2 });

anchor.destroy(); // `joint` is destroyed with it; `bob` stays in the world, unconstrained
```

Two things leave the joint entity alone:

- Removing a connected body's `Body` component, without destroying its entity,
  tears the constraint down. The joint entity stays and rebuilds the constraint
  once the body carries a `Body` again.
- Pointing a slot at a different body rebuilds the joint on the new body.
  Destroying the replaced body afterwards does not touch the joint, so re-point
  the slot first to keep a joint entity when one of its bodies goes away.

## Not yet included

This version ships revolute, distance, prismatic, wheel, weld, filter, and
motor joints — every Box2D joint type. Breakable-joint events are planned —
see [Roadmap](./roadmap.md).

## Related Pages

- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Core Components](./components.md)
- [Systems And Phases](./systems-and-phases.md)
- [Roadmap](./roadmap.md)
