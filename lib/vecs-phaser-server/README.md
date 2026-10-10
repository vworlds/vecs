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

**No unsynced pose reaches the wire.** The sync systems run in `POST_UPDATE`, so an entity that gets
its pose later in the frame, in `PRE_STORE`, `ON_STORE` or an RPC handler, would enter them only on
the next tick, and the frame in flight would carry its render pose at the default (0, 0). A third
system, `phaser.guard.pose`, runs in a phase of its own, inserted right after `ON_STORE` and before
`ServerWorld`'s store phase (so after every user phase, and before the frame is recorded and sent).
It drains a worklist that the `add` hooks of the physics and the render pose fill when an entity
holds both halves of a pair, and copies the physics pose into a render pose that differs, change-only
and announced with `modified`, like the sync systems. An entity that `POST_UPDATE` already synced
costs one comparison, a frame with nothing queued costs an empty check, and modifying a pose adds
no work. The guard covers an entity created or completed late, not a physics pose that game code
writes late on an entity that was already synced: that one reaches the render pose on the next tick.

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
flies or comes to rest needs no pose traffic between corrections and moving-baseline refreshes,
but session keepalives still advance the client's render frame.

### Setting it up

Append `phaserMotionComponents` to the network components, on the server and the client alike, then
install the module after `PhysicsModule`. Tag each body that should be dead reckoned, when you spawn
it or later (see [Switching at runtime](#switching-at-runtime)):

```ts
import { DeadReckoned, DeadReckonedModule } from "@vworlds/vecs-phaser-server";

const world = new ServerWorld({
  name: "main",
  networkComponents: [...phaserNetworkComponents, ...appComponents, ...phaserMotionComponents],
  keepAliveFrames: 1,
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

### Set `keepAliveFrames: 1`

The module throws at install unless the `ServerWorld` sets `keepAliveFrames`, and `1` is the value
to use. Clients extrapolate a body at `ClientWorld.renderFrame`, which advances only as frames
arrive, and the server sends a session nothing while its replicated state is unchanged. A scene of
bodies that drift between corrections replicates nothing for seconds, so without a keepalive every
dead-reckoned body freezes at the pose of the last frame and jumps when the next one arrives. In
Space Rocks, with a parked ship and drifting rocks, that was holds of up to 3.5 s and jumps of about
3 m. A scene that changes on every tick never notices, which is why this shows only in idle ones.

With `keepAliveFrames: 1` a session that was sent no frame with a diff in the last tick is sent one
with an empty diff, a header of 5 to 11 payload bytes, so `renderFrame` and the bodies move on every
tick. That is 150 to 330 payload B/s per idle client at 30 Hz, excluding transport and ACK overhead, and nothing for a
session that is sent a diff anyway. A larger value saves bytes at the price of the render frame
waiting for each keepalive: `2` still looks smooth on a steady link and `3` or more stalls and jumps.
It combines with any `redundancyFrames`: in an idle scene the keepalives are plain deltas from the
client's ack, so a lost one never makes the client report a gap. See
[`keepAliveFrames`](../vecs-server/docs/sessions.md#keepalive-keepaliveframes) and
[Replication](../../architecture/REPLICATION.md#the-keepalive).

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
- Removing it removes `Motion`, `MotionParams` and the prediction, and gives the entity a render
  `Position` and `Rotation` that hold the physics pose.
- Once a switch completes, a dead-reckoned entity carries no render pose, and adding a render
  `Position` or `Rotation` to one throws. The switch itself never trips that check.

A body under constant divergence, such as a driven or jointed one, costs a baseline of about 27
bytes per step against about 22 for a streamed pose update, so keep constantly driven bodies
streamed, and switch the tag on a change of state (see [Switching at runtime](#switching-at-runtime)).

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
A baseline at rest bypasses the integrator on both ends: the server's prediction and every client
hold exactly the baseline's `x`, `y` and `angle`, with no center-of-mass round trip and no `atan2`,
so an off-center body is held where the physics pose put it.

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
  `modified`, in the same frame as the `Motion`, so both land in the same diff. It writes through
  the callback form of `entity.ensure`, so the write is complete before the announcement whether or
  not the world is deferred. A body that never leaves the defaults, such as a bullet, never carries
  one: `DeadReckoned` does not bring it.
- Once added it is kept and updated for as long as the entity stays dead reckoned, and it goes with
  the tag. A baseline at rest leaves it untouched, because nothing is stepped. A body that returns
  to dead reckoning gets it again with its first baseline, if its constants are not the defaults.
- Changing a body's damping, say, shows up as divergence like any other change: one baseline and
  one `MotionParams` update follow, in the same frame.

The prediction the system runs keeps its own copy of the constants, taken when it writes the
baseline. Clients do the same: they copy the entity's `MotionParams` when they take a baseline.

### Switching at runtime

`DeadReckoned` may be added or removed at any time, so a body can be dead reckoned while it drifts
and streamed while something drives it: a container that drifts free, and is towed in a jointed
train, which would diverge from its prediction almost every step.

```ts
container.remove(DeadReckoned); // towed: stream its pose
container.add(DeadReckoned); // released: dead reckon it again
```

| Switch                    | Same frame, in one diff                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Streamed to dead reckoned | `Motion` (and `MotionParams`, if the constants differ) is set, and the render `Position` and `Rotation` go |
| Dead reckoned to streamed | The render `Position` and `Rotation` are set to the physics pose, and `Motion` and `MotionParams` go       |

- **Adding the tag** to a streamed body removes its render pose, and the first baseline is written
  in that frame, whichever phase added it: `phaser.sync.motion` writes it in `POST_UPDATE`, and the
  pose guard (below) in a later phase.
- **Removing the tag** removes `Motion`, `MotionParams` and the prediction. Called outside a system
  it adds the render pose at once. Called from a system, the removals apply when its commands
  flush, and the render pose is added by the pose guard at the end of the frame, from the entity as
  it is then. That keeps a remove and an add of the tag in one flush, either way round, from meeting
  the check that rejects a render pose on a dead-reckoned entity.
- **Repeated toggling** works. A body that returns starts fresh: a new prediction and baseline, and
  its `MotionParams` again when its constants are not the defaults.
- **Clients** keep the render pose present through the hand-off in both directions, with no
  `remove` or `add` on it, and blend the difference between the pose they showed and the pose the
  new source gives (see [Dead reckoning on the client](../vecs-phaser-client/README.md#dead-reckoning)).
  A streamed body whose updates stop holds its last pose until the baseline's frame, since the
  switching diff has no render pose to interpolate toward, so expect a stall of about one server
  frame before the blend catches up.

Switch on a change of state, not every frame: each switch costs a baseline one way and a pose
update the other. Keep a body that is constantly driven streamed, and toggle the tag when its state
changes.

#### The pose guard

An entity that becomes dead reckoned after `POST_UPDATE`, or is created there, would ship its
default `Motion` (frame 0 at the origin) until the next tick. The system `phaser.guard.motion` runs
in the phase `PhaserServerModule` places after `ON_STORE` and before `ServerWorld`'s store phase,
and writes the first baseline of every entity whose prediction is still unprimed, so **no `Motion`
reaches the wire before it reflects the physics pose**. Together with the streamed guard (see the
top of this file), no pose, render pose or `Motion`, reaches the wire before it reflects the
physics pose, whatever phase created or switched the entity.

An entity that `phaser.sync.motion` primed in `POST_UPDATE` costs one check, and a frame with
nothing queued costs an empty check. A body whose Box2D body does not exist yet, one created this
very frame, gets a baseline at rest at its physics pose; its first step creates the body, finds it
off the held pose and writes a corrected baseline with the real velocities.

### Moving to another world

`DeadReckoned` is a plain tag, so `moveSubtree` and `restoreSubtree` carry it (list it when you
pass a `components` allowlist). `Motion` belongs to the source world, whose frames it counts, and
the prediction is never captured, so the destination starts the body unprimed and writes a fresh
baseline, at its own frame, on the body's first step there. That baseline compares the body's
constants with the `MotionParams` that came with it, if any, and writes the component again when
they differ, so a destination that did not receive it still ends up right. Install
`DeadReckonedModule` in the destination world too; the application does nothing else.
