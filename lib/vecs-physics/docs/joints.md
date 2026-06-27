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

A joint entity needs two relationships — `JointBodyA` and `JointBodyB` — pointing
at the connected body entities, and exactly one joint-type component:

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

world
  .entity()
  .set(JointBodyA, { target: anchor })
  .set(JointBodyB, { target: bob })
  .set(DistanceJoint, { length: 2 });
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
  .set(JointBodyA, { target: anchor })
  .set(JointBodyB, { target: bob })
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
exclusive, like geometry components). This version ships four types:

| Type            | Constraint                                                             |
| --------------- | ---------------------------------------------------------------------- |
| `RevoluteJoint` | Hinge: pins the bodies at a shared anchor, free relative rotation.     |
| `DistanceJoint` | Keeps the two anchors a fixed `length` apart (a rigid rod by default). |
| `WeldJoint`     | Rigidly fixes the relative position and orientation.                   |
| `FilterJoint`   | Disables collision between the two bodies without constraining them.   |

`DistanceJoint` carries a `length` field; the other three are markers whose
behaviour is shaped by the frame and feature components.

## Features: motor, limit, spring

Optional features are reusable components shared across joint types. **A feature
is enabled exactly when its component is present** — there is no `enableMotor`
flag. Add the component to enable and tune the feature, remove it to disable,
re-set it to retune, all independently of one another and of the joint itself.

```ts
import { JointMotor, JointLimit, JointAngularSpring } from "@vworlds/vecs-physics";

const hinge = world
  .entity()
  .set(JointBodyA, { target: anchor })
  .set(JointBodyB, { target: bob })
  .add(RevoluteJoint);

hinge.set(JointMotor, { targetSpeed: 2, maxForce: 50 }); // drive the hinge
hinge.set(JointLimit, { lower: -0.5, upper: 0.5 }); // clamp the angle (radians)

hinge.remove(JointMotor); // stop driving; the hinge swings freely again
```

- `JointMotor { targetSpeed, maxForce }` — drives the joint toward `targetSpeed`
  (rad/s for revolute, m/s for distance), bounded by `maxForce` (a torque on
  angular joints).
- `JointLimit { lower, upper }` — an angle range (radians) for revolute, a length
  range (meters) for distance.
- `JointLinearSpring { hertz, dampingRatio }` — a soft constraint along the
  linear axis (distance, and the linear axis of weld).
- `JointAngularSpring { hertz, dampingRatio }` — a soft constraint on the
  relative angle (revolute, and the angular axis of weld). Split from the linear
  spring so a weld can carry both at once.

### Which features apply to which type

| Type            | Motor | Limit | Linear spring | Angular spring |
| --------------- | :---: | :---: | :-----------: | :------------: |
| `RevoluteJoint` |  yes  |  yes  |       —       |      yes       |
| `DistanceJoint` |  yes  |  yes  |      yes      |       —        |
| `WeldJoint`     |   —   |   —   |      yes      |      yes       |
| `FilterJoint`   |   —   |   —   |       —       |       —        |

A feature component on a type that does not support it is ignored.

## Letting the connected bodies collide

By default the two connected bodies do not collide with each other. Add
`JointSettings` to allow it:

```ts
import { JointSettings } from "@vworlds/vecs-physics";

joint.set(JointSettings, { collideConnected: true });
```

## Lifecycle

| ECS change                               | Physics behavior                                       |
| ---------------------------------------- | ------------------------------------------------------ |
| Both bodies have `Body` + joint-type set | Create the joint.                                      |
| Remove the joint-type component          | Destroy the joint.                                     |
| Destroy the joint entity                 | Destroy the joint; bodies are unaffected.              |
| Destroy a connected body                 | The body's joints are destroyed with it.               |
| Retarget `JointBodyA`/`JointBodyB`       | Rebuild the joint on the new bodies.                   |
| Change `JointFrame` / `DistanceJoint`    | Rebuild the joint with the new geometry.               |
| Add/remove/change a feature component    | Enable/disable/retune that feature, waking the bodies. |

Destroying a connected body matches Box2D: the body's joints go with it. (When
the body also owns child shapes, the joint's Box2D constraint is still torn down
correctly; the joint entity itself may linger until next destroyed — see the note
in the roadmap.)

## Not yet included

This version ships revolute, distance, weld, and filter joints. Prismatic,
wheel, and motor joints, and breakable-joint events, are planned — see
[Roadmap](./roadmap.md). The component model (relationships + exclusive
type components + reusable feature components) is designed so they slot in
without changing the existing API.

## Related Pages

- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Core Components](./components.md)
- [Systems And Phases](./systems-and-phases.md)
- [Roadmap](./roadmap.md)
