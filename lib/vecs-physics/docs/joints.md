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

| ECS change                                           | Physics behavior                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Both bodies have `Body` + joint-type set             | Create the joint.                                                         |
| Remove the joint-type component                      | Destroy the joint.                                                        |
| Destroy the joint entity                             | Destroy the joint; bodies are unaffected.                                 |
| Destroy a connected body                             | Detach the joint: its constraint is torn down, the joint entity survives. |
| Add `JointBodyA`/`JointBodyB` with a different body  | Replace that slot's target and rebuild the joint.                         |
| Change `JointFrame` / `DistanceJoint` / `MotorJoint` | Rebuild the joint with the new geometry/fields.                           |
| Add/remove/change a feature component                | Enable/disable/retune that feature, waking the bodies.                    |

### Destroying a connected body

When a connected body is destroyed, the joint's Box2D constraint is torn down (the
joint stops matching once the body loses its `Body` component), but **the joint
entity is not destroyed** — it is yours to manage. You can re-point its
`JointBodyA`/`JointBodyB` at another body to reconnect it, attach it to a manager
entity with `ChildOf` so it is cleaned up with that, or destroy it directly.

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
