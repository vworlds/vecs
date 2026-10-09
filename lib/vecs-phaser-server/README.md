# @vworlds/vecs-phaser-server

Server helpers for vecs-backed Phaser worlds. `PhaserServerModule`, when installed on a
`ServerWorld`, marks `DrawIn` and `DrawBy` as single-target (`Exclusive`) relationships, marks only
`DrawBy` as `Traversable`, makes the renderable components mutually exclusive
(`setExclusiveComponents(...phaserRenderableComponents)` — one shape per entity) and installs
two reactive `POST_UPDATE` pose-sync systems that copy `vecs-physics` `Position`/`Rotation`
into the render `Position`/`Rotation` whenever the physics body pose changes. No `phaser`
dependency.

The sync systems (`phaser.sync.position` and `phaser.sync.rotation`) inject the render component,
which their query guarantees, and write it only when it differs from the physics value, compared
field by field with exact equality, both when the physics pose changes and when an entity enters.
They never create the render component. A changed pose is assigned into the injected instance and
announced with `entity.modified(...)`, which fires the same `set` hooks, routes the same `update`
events and replicates the same way `set` does. Every modification replicates a networked component,
so a body that does not move or turn rewrites, and therefore re-sends, nothing: a bullet flying
straight keeps its constant render `Rotation` out of the network. For the same reason, `set` hooks
and `update` systems on the render pose run when the pose changed, not on every step. A system that
must visit every entity every step should iterate with `each`, which does not wait for a change; see
[Pose Updates Fire Only When The Pose Changes](../vecs-physics/docs/systems-and-phases.md#pose-updates-fire-only-when-the-pose-changes).

Create display edges with `entity.add(DrawIn, parent)` or `entity.add(DrawBy, parent)`. Relationship
targets are not component payload properties, and the server module does not make the two display
relationship component types mutually exclusive; `DisplaySetupModule` applies that local invariant
on clients.

Depends on `@vworlds/vecs-phaser`, `@vworlds/vecs-server`, and `@vworlds/vecs-physics`.

`AssetManager` owns the server-side Tiled tileset catalog. Construct it with
`new AssetManager({ assetsPath })` to scan and load every supported asset under `assetsPath`, then
call `getTileset(key)` to get a typed `TilesetAsset` with frame dimensions, `tile(id)` metadata,
and `sizeInMeters(ppm)` for matching physics bodies to art. `mount(app, worldName)` serves the
catalog JSON and static image files over the same Express app. The Tiled schema used for ingestion
is vendored and minimal; there is no `@kayahr/tiled` runtime dependency.

## Dead reckoning

`DeadReckonedModule` sends a body's pose as an occasional `Motion` baseline that clients
extrapolate, instead of streaming every change of its render pose (#217). A body that drifts,
flies or comes to rest costs nothing between collisions, teleports and falling asleep.

### Setting it up

Append `phaserMotionComponents` to the network components, on the server and the client alike, then
install the module after `PhysicsModule`. Tag each body that should be dead reckoned when you spawn
it:

```ts
import { DeadReckoned, DeadReckonedModule } from "@vworlds/vecs-phaser-server";

const world = new ServerWorld({
  name: "main",
  networkComponents: [...phaserNetworkComponents, ...appComponents, ...phaserMotionComponents],
});
world.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
world.module(DeadReckonedModule, { positionTolerance: 0.01, angleTolerance: 0.01 });

const rock = world
  .entity()
  .add(Networked)
  .add(DeadReckoned)
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 4, y: 2 }) // the physics Position
  .set(LinearVelocity, { x: 3, y: 0 })
  .set(Arc, { radius: 0.5 });
world.entity().childOf(rock).set(Circle, { radius: 0.5 });
```

The module creates the world's one `MotionClock` entity, `Networked`, from the physics settings:
step, substeps, gravity and maximum linear speed. Clients cannot extrapolate without it, so every
session's `View` must see it, for example with `{ any: [InMySector, MotionClock] }`. Adding
`MotionClock` to any other entity throws. The world must be a `ServerWorld`, since baselines are
stamped with `ServerWorld.frame`, and step physics once per tick.

### Game code owns the physics pose

On the server, game code reads and writes the physics `Position` and `Rotation` of every entity,
dead reckoned or streamed, with or without a `Body`. The render `Position` and `Rotation`, `Motion`
and `MotionParams` are only wire encodings of that pose and the body behind it, and only the sync
systems write them:

| Body                  | Carries                                                                                | Synced by                                      | Sent                           |
| --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| Streamed (default)    | physics pose + render `Position` / `Rotation`                                          | `phaser.sync.position`, `phaser.sync.rotation` | every change                   |
| `DeadReckoned`        | physics pose + `Motion` (+ `MotionParams` if the constants differ), **no render pose** | `phaser.sync.motion`                           | a baseline, on divergence only |
| No `Body` (an effect) | physics pose + render `Position` / `Rotation`                                          | `phaser.sync.position`, `phaser.sync.rotation` | every change                   |

The systems match on presence, so each entity takes exactly one path. `DeadReckoned` makes that
structural:

- Adding it adds `Motion`, the physics `Rotation` and a server-local prediction, and removes the
  render `Position` and `Rotation`. `MotionParams` is not part of it: see
  [Body constants](#body-constants).
- Adding a render `Position` or `Rotation` to a dead-reckoned entity throws.
- Decide it at spawn. Removing the tag, or adding it to a body clients already stream, is not
  supported.

A body under constant divergence, such as a driven or jointed one, costs a baseline of about 27
bytes per step against about 22 for a streamed pose update, so keep constantly driven bodies
streamed.

### When a baseline is sent

`phaser.sync.motion` runs in `POST_UPDATE`, after the physics step. Each step it advances the
prediction clients run by one step with the shared integrator, starting from the baseline exactly
as clients decode it, and compares it with the physics pose. It writes a new baseline when:

| Trigger                           | Option              | Default  | Baseline                               |
| --------------------------------- | ------------------- | -------- | -------------------------------------- |
| The position strays further than  | `positionTolerance` | 0.01 m   | the pose and Box2D's velocities        |
| The angle strays further than     | `angleTolerance`    | 0.01 rad | as above                               |
| The body falls asleep             |                     |          | at rest (`Motion.rest`): the pose only |
| A moving baseline gets older than | `maxBaselineAge`    | 30 s     | as above; `0` never refreshes          |

Collisions, teleports, joints, forces and changed body settings all show up as divergence, with no
special case. A new body gets its first baseline on its first step. Each baseline is stamped with
the frame clients receive it at and replicates through the acknowledged history, so loss delays a
correction but never loses it. The refresh bounds the steps a client runs to catch up a body it has
just started to see; a baseline at rest is never refreshed. An entity without a `Body` that is
tagged `DeadReckoned` gets baselines at rest whenever game code moves it.

A baseline is **at rest** when the body is asleep, when the entity has no body, or when the body
has no velocity and nothing accelerates it: the world has no gravity, or the body's effective
gravity scale is 0. The server decides it and sends only the pose and the `rest` flag (14 bytes
against 26 for a moving baseline, with a frame below 128); clients hold the pose and never step it.

Per body per step the system steps the integrator once and compares, allocating nothing and looking
up no component. It asks Box2D whether the body sleeps only when its pose did not change, and reads
the rest of the body's motion only when it writes a baseline. A body at rest costs one comparison.

### Body constants

A body's damping, center of mass, effective gravity scale (0 for a body without mass) and
`allowFastRotation` do not travel in `Motion`. They live in a `MotionParams` on the same entity,
which clients step every baseline with, so a correction costs the pose and velocities only.
`phaser.sync.motion` writes it as follows:

- Each time it writes a **moving** baseline it compares the body's constants, rounded to f32, with
  the entity's `MotionParams`, or with the defaults (no damping, the center of mass at the origin,
  a gravity scale of 1, no fast rotation) when the entity has none.
- Only when they differ does it add the component, or update it in place, and announce it with
  `modified`, in the same frame as the `Motion`, so both land in the same diff. A body that never
  leaves the defaults, such as a bullet, never carries one: `DeadReckoned` does not bring it.
- Once added it is kept and updated, never removed. A baseline at rest leaves it untouched,
  because nothing is stepped.
- Changing a body's damping, say, shows up as divergence like any other change: one baseline and
  one `MotionParams` update follow, in the same frame.

The prediction the system runs keeps its own copy of the constants, taken when it writes the
baseline. Clients do the same: they copy the entity's `MotionParams` when they take a baseline.

### Moving to another world

`DeadReckoned` is a plain tag, so `moveSubtree` and `restoreSubtree` carry it (list it when you
pass a `components` allowlist). `Motion` belongs to the source world, whose frames it counts, and
the prediction is never captured, so the destination starts the body unprimed and writes a fresh
baseline, at its own frame, on the body's first step there. That baseline compares the body's
constants with the `MotionParams` that came with it, if any, and writes the component again when
they differ, so a destination that did not receive it still ends up right. Install
`DeadReckonedModule` in the destination world too; the application does nothing else.
