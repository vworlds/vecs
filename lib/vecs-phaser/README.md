# @vworlds/vecs-phaser

Data-only package providing wire-serializable Phaser render components (`Position`, `Arc`,
`Text`, `Image`, …) and the `phaserNetworkComponents` protocol order. `Image` is the first
textured renderable and is protocol type 17. `OpenPath` (type 23) is a tag that leaves the stroke
of an `Arc` or `Polygon` open, for progress rings and polylines. No `phaser` dependency.

The protocol also includes `DrawIn` for native Phaser Container parenting and `DrawBy` for
computed scene-root parenting. Both are networked relationship classes. `DisplaySetupModule` and
`PhaserServerModule` configure them as single-target (`Exclusive`) relationships in their worlds;
client setup also makes `DrawBy` traversable, while `DrawIn` is not.

A `DrawBy` child follows its parent's `Position` only: the `Offset` is added as is and the child's
own `Rotation` stays independent. `InheritRotation` is an opt-in tag that puts the child in its
parent's local frame instead, so the `Offset` turns with the parent and the child's `Rotation` is
the parent's angle plus the tag's `angle`. The tag is a wire type but deliberately not part of
`phaserNetworkComponents`, because that list's order is the protocol and appending to it shifts the
wire ids of every application component listed after it. It is client-local by default; an
application that wants the server to set it lists it in its own network components, after its
existing ones.

Also exports the shared asset catalog schema (`AssetDescriptor`, `SpritesheetDescriptor`,
`AssetCatalog`) used by `@vworlds/vecs-phaser-server` to describe server-owned assets and by
`@vworlds/vecs-phaser-client` to load them before rendering.

## Dead reckoning

`Motion` and `MotionClock` let a client extrapolate a physics body instead of receiving its pose
every tick (#217). `Motion` is a complete baseline: the body origin, angle and velocities at a
server frame, plus its damping and local center of mass when they are non-zero. `MotionClock` is
the world's physics step, substep count, gravity and maximum linear speed, carried by one entity.
`Motion` costs 26 bytes with a frame below 128, plus 8 for the damping pair and 8 for the local
center.

Neither is in `phaserNetworkComponents`. An application that uses dead reckoning appends
`phaserMotionComponents` (`MotionClock`, then `Motion`) to its own network components, after its
existing entries, on the server and the client alike, so no wire id shifts.

The shared integrator predicts the body from its baseline. It mirrors Box2D v3's free-body step as
box2d3-wasm builds it, in f32 and with no `sin`, `cos` or `atan2` per step, so every JS engine
computes the same states, and from a rotation Box2D holds exactly they equal Box2D's bit for bit.
It allocates nothing:

```ts
import { Motion, MotionClock, MotionPose, MotionState } from "@vworlds/vecs-phaser";
import { motionPose, motionStateFrom, stepMotion } from "@vworlds/vecs-phaser";

const motion = Object.assign(new Motion(), { vx: 6, vy: -8, w: 2, linearDamping: 0.15 });
const clock = new MotionClock();
const state = motionStateFrom(motion, new MotionState());
const pose = new MotionPose();

stepMotion(state, motion, clock); // one physics step
motionPose(state, motion, pose); // pose.x, pose.y, pose.angle
```

Forces, contacts, joints, locked axes, `allowFastRotation`, a gravity scale other than 1 and sleep
are not modeled: a body they affect leaves the prediction, and the server sends a new baseline. The
server and client modules that send baselines and extrapolate them arrive in a follow-up pull request for #217.

Depends on `@vworlds/vecs` and `@vworlds/vecs-wire`.

See [`./architecture/README.md`](./architecture/README.md) for the full design.
Forward-looking work lives in the repo [`ROADMAP.md`](../../architecture/ROADMAP.md).
