# @vworlds/vecs-phaser-client

Browser render adapter: registers a vecs module that observes a replicated `ClientWorld`
and automatically creates, updates, and destroys Phaser GameObjects. Each live Phaser
GameObject is attached to its entity **as a component** (`entity.attach(obj)`), and the
renderer dispatches transform/style updates polymorphically through `Implements` interface
markers (`GameObject`, `Transform`, `Fill`, …). All pixel, PPM, and Y-flip conversion lives
here at the Phaser frontier.

Depends on `@vworlds/vecs-phaser` and `@vworlds/vecs-client`. Requires `phaser@^4.1.0` as
a peer dependency (provided by the application).

## Asset Loading

Load server-owned assets before connecting the world, then pass the resolved catalog to
`PhaserRenderModule`:

```ts
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { PhaserRenderModule, loadAssets } from "@vworlds/vecs-phaser-client";

const catalog = await loadAssets(scene, {
  host: "localhost",
  port: 8080,
  worldName: "main",
  onProgress: (value) => updateLoadingBar(value),
});

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "main",
  networkComponents: phaserNetworkComponents,
});

world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64, catalog });
```

`loadAssets` removes the Phaser loader listeners it adds when the load completes or is
aborted, so calling it on every world switch does not leak
listeners. A file that fails to load does not reject: the load still resolves when Phaser emits
`complete`, and `catalog.failed` lists the keys of the files that failed, so one missing texture
does not block a world switch. Pass `signal` to cancel a load: the promise rejects with the signal's reason and the
loader is reset.

```ts
const controller = new AbortController();
const catalog = await loadAssets(scene, { host, port, worldName, signal: controller.signal });
```

The `Image` renderer creates textured entities from replicated `Image` components with no
per-entity client code, like the primitive shape renderers.

## Attaching your own Phaser objects

The sync systems never look for a concrete Phaser class. They query the interface markers
exported as `markers`, so any Phaser object you attach to an entity is driven by them once its
class declares which markers it satisfies. Use this when a built-in renderer does not cover
your object, for example a sprite drawn from a texture the scene paints at runtime, which has
a string key the asset catalog cannot describe.

`PhaserRenderModule` already declares `Phaser.GameObjects.Sprite`, so a game system only has to
create the sprite and attach it. Create it in a phase before `ON_STORE` (here `PRE_STORE`): the
sync systems run in `ON_STORE` and then apply the entity's current `Position`, `Rotation`,
`Alpha`, `Depth` and `Tint` in the same tick.

```ts
import { PRE_STORE } from "@vworlds/vecs";
import { PhaserRenderModule } from "@vworlds/vecs-phaser-client";
import Phaser from "phaser";

world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
world.component(Ship);

function shipTexture(accent: number): string {
  const key = `ship:${accent}`;
  if (!scene.textures.exists(key)) {
    const canvas = scene.textures.createCanvas(key, 64, 64)!;
    paintShip(canvas.getContext(), accent);
    canvas.refresh();
  }
  return key;
}

world
  .system("ship.sprite")
  .with(Ship)
  .without(Phaser.GameObjects.Sprite)
  .phase(PRE_STORE)
  .enter([Ship], (entity, [ship]) => {
    entity.attach(scene.add.sprite(0, 0, shipTexture(ship.accent)));
  });
```

No wrapper component and no per-tick pose system is needed: `phaser.sync.position`,
`phaser.sync.rotation`, `phaser.sync.alpha`, `phaser.sync.depth` and `phaser.sync.tint` drive the
attached sprite. Teardown needs no system either: the `GameObject` remove hook destroys the
sprite when the entity is destroyed or loses the sprite component.

A class `PhaserRenderModule` does not declare, including your own subclass of a Phaser class,
is a component type of its own and needs its own declaration before you attach it. List only
the markers whose methods the class has:

```ts
import { Implements } from "@vworlds/vecs";
import { markers } from "@vworlds/vecs-phaser-client";

class ThrusterGlow extends Phaser.GameObjects.Sprite {}

world.component(ThrusterGlow).set(Implements, {
  interfaces: [markers.GameObject, markers.Transform, markers.Alpha, markers.Depth, markers.Tint],
});
```

| Marker       | Methods the class needs                  | Driven by                                                                                 |
| ------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GameObject` | `destroy`                                | The remove hook that destroys the object                                                  |
| `Transform`  | `setPosition`, `setRotation`, `setScale` | `phaser.sync.position`, `phaser.sync.rotation`, `phaser.sync.scale`, `phaser.sync.offset` |
| `Alpha`      | `setAlpha`                               | `phaser.sync.alpha`                                                                       |
| `Depth`      | `setDepth`                               | `phaser.sync.depth`                                                                       |
| `Tint`       | `setTint`                                | `phaser.sync.tint`                                                                        |
| `Size`       | `setSize`                                | `phaser.sync.size`                                                                        |
| `Fill`       | `setFillStyle`                           | `phaser.sync.fill-style`                                                                  |
| `Stroke`     | `setStrokeStyle`                         | `phaser.sync.stroke-style`                                                                |
| `OpenPath`   | `setClosePath`                           | `phaser.sync.open-path`                                                                   |
| `Texture`    | `setTexture`, `setDisplaySize`           | The `Image` texture and display-size systems (needs the `Image` component)                |

The geometry markers (`Shape`, `Arc`, `Vertices`, `Star`, `Text`) serve the built-in shape and
text renderers. Each marker's reference comment is in
[`src/markers.ts`](./src/markers.ts).

## Display Relationships

`DisplaySetupModule` configures `DrawIn` and `DrawBy` as `Exclusive` relationships, so each has at
most one target. It separately makes the two component types mutually exclusive on an entity.
`DrawBy` is `Traversable`; `DrawIn` is not. Replicated relationship snapshots ghost every missing
target and reconcile all target edges before display placement, so children can arrive before their
parents.

Use `entity.add(DrawIn, parent)` for native Phaser Container parenting or
`entity.add(DrawBy, parent)` for computed scene-root parenting. Root GameObjects have neither
relationship. The computed resolver (`phaser.resolve.offset`) reads the `DrawBy` parent's
interpolated `Position` and adds `Offset` directly to it; it does not use `DrawIn`, and unless the
child opts in below, the parent's rotation neither turns the offset nor the child.

### Destroying the display parent

`DrawIn` and `DrawBy` use `CleanupPolicy.Remove` (`DisplaySetupModule` sets it, and it is the default
for any relationship), unlike `ChildOf`, which uses `Delete`. Destroying a display parent therefore
only removes the edge from each child: the child **entity** is not destroyed, and a `DrawBy` child
stays on the scene root with the pose it was last resolved to.

For `DrawIn`, the render module's remove hook detaches the Container's children before destroying
it. Their GameObjects survive and return to the scene display list, including a nested Container
with its own children intact. Containers retain Phaser's default exclusive parenting semantics;
only ECS teardown detaches children to keep display parenting separate from ownership.

A display child that must die with its parent needs an ownership edge as well, because the display
edges never destroy anything. Give it a `ChildOf` edge to the parent, which coexists with `DrawIn`
and `DrawBy`, or make it an owned target of the parent
([`Exclusive` + `OwnedTarget`](../vecs/docs/relationships.md#owned-targets)), which parents it
through `ChildOf`:

```ts
import { DrawBy, Offset, OpenPath, Polygon } from "@vworlds/vecs-phaser";

// Client code: the crack is drawn by `rock` and is destroyed with it.
world
  .entity()
  .add(DrawBy, rock) // display link: only this edge goes when the rock is destroyed
  .childOf(rock) // ownership link: the rock's destruction destroys the crack
  .set(Offset, { x: 0.2, y: 0.1 })
  .set(Polygon, { points: [0, 0, 0.3, 0.1, 0.5, 0.4] })
  .add(OpenPath);
```

`ChildOf` is not in `phaserNetworkComponents`, so it does not replicate unless your application
lists it. A child the server creates gets its `ChildOf` on the server, where the cascade runs; a
child that client code creates gets it in client code, as above. The design is in
[Container lifetime](../vecs-phaser/architecture/README.md#container-lifetime).

### Turning with the parent

Add `InheritRotation` to a `DrawBy` child to put it in its parent's local frame: a crack on a
spinning rock, or a label that turns with its body. The same resolver pass then rotates the
`Offset` by the parent's `Rotation` and gives the child a `Rotation` equal to the parent's angle
plus the tag's `angle`, so position and rotation stay in lockstep on every frame, interpolated
ones included. A `DrawIn` child needs no tag, since Phaser composes its transform natively.

```ts
import { DrawBy, InheritRotation, Offset, OpenPath, Polygon } from "@vworlds/vecs-phaser";

// Client code: `rock` is a replicated renderable that spins; the crack drawn on it turns with it.
world
  .entity()
  .add(DrawBy, rock)
  .set(Offset, { x: 0.2, y: 0.1 })
  .set(InheritRotation, { angle: 0.3 })
  .set(Polygon, { points: [0, 0, 0.3, 0.1, 0.5, 0.4] })
  .add(OpenPath);
```

- The tag's `angle` is the child's own angle relative to its parent, in radians, counter-clockwise
  positive. Leave it `0` to follow the parent's orientation.
- Adding the tag also adds a client-local `Rotation` to the child. It holds the derived angle and
  is rewritten every frame, so setting or replicating `Rotation` on a tagged child has no effect.
- A parent that is itself tagged passes its derived angle down, so angles add and offsets compose
  along the chain, which resolves parent-first within a single frame.
- Removing the tag from a `DrawBy` child returns it to its own rotation: its `Rotation` becomes the
  tag's `angle` and its offset is no longer rotated.
- The tag does nothing without `DrawBy`, so removing it from an entity that has none leaves that
  entity's `Rotation` alone. A child whose `DrawBy` is removed (for example because its parent was
  destroyed) keeps the pose it was last resolved to, and removing the tag afterwards leaves that
  pose alone.
- `InheritRotation` is not part of `phaserNetworkComponents`, so it is client-local unless your
  application lists it in its own network components, after its existing ones, on the server and
  the client alike. See the `InheritRotation` JSDoc for the full rules.

## Interpolation

`ClientWorld` interpolation is configured at construction/connect time. No
interpolators are registered by default — pass `phaserInterpolators()` to opt
into interpolation for the standard Phaser transform components. It installs
`interpolatePosition` (linear `{x,y}` lerp) on the `Position` wire type and
`rotationInterpolator` (shortest-arc angular lerp) on the `Rotation` wire
type, both looked up from `phaserNetworkComponents`:

```ts
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { PhaserRenderModule, phaserInterpolators } from "@vworlds/vecs-phaser-client";

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "main",
  networkComponents: phaserNetworkComponents,
  interpolators: phaserInterpolators(),
});

world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
```

Pass `phaserInterpolators({ interpolateRotation: false })` to snap rotation
updates while still interpolating `Position`. To disable interpolation
entirely, omit `interpolators` (or pass an empty list).

## Headless clients

Use `@vworlds/vecs-phaser-client/headless` for Node bots, e2e tests, probes and tools that
need client poses without loading Phaser. It exports `DeadReckonedModule`, the type
`DeadReckonedModuleConfig`, `phaserInterpolators` and `rotationInterpolator`. Browser clients
can keep importing these from the main entry.

```ts
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserMotionComponents, phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { DeadReckonedModule, phaserInterpolators } from "@vworlds/vecs-phaser-client/headless";

const world = new ClientWorld({
  networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
  interpolators: phaserInterpolators(),
});
world.module(DeadReckonedModule);
// Attach your transport with world.attachSocket(socket), then progress on your client loop.
world.progress(performance.now(), 16);
```

Keep the network component order identical to the server's, including any app components before
`phaserMotionComponents`. See [Dead reckoning](#dead-reckoning) for clock and correction behavior.
The main entry also exports renderers and loads Phaser; use the headless subpath in Node.

## Dead reckoning

`DeadReckonedModule` extrapolates the bodies a server sends as `Motion` baselines instead of
streamed poses (see [Dead reckoning on the server](../vecs-phaser-server/README.md#dead-reckoning)).
Append `phaserMotionComponents` to the network components, as the server does, and install the
module. For Node clients, use the [headless entry](#headless-clients):

```ts
import { phaserMotionComponents, phaserNetworkComponents } from "@vworlds/vecs-phaser";
import {
  DeadReckonedModule,
  PhaserRenderModule,
  phaserInterpolators,
} from "@vworlds/vecs-phaser-client";

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "main",
  networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
  interpolators: phaserInterpolators(),
});

world.module(DeadReckonedModule, { blendMs: 100, snapDistance: 1, snapAngle: 0.5 });
world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
```

A dead-reckoned body arrives with `Motion` and no `Position` or `Rotation`. `Motion` brings a
client-local `Position` and `Rotation` with it, and the extrapolator writes them every frame, so the
renderers, `DrawBy` children and game systems use them as they use an interpolated pose:

- **One timeline.** It samples each baseline at `ClientWorld.renderFrame`, the server frame the
  interpolators sample: it steps the shared integrator `floor(renderFrame - Motion.frame)` physics
  steps from the baseline and interpolates the fraction toward the next step. Extrapolated and
  interpolated entities show the same moment.
- **Same frame.** The system, `phaser.extrapolate.motion`, runs in `POST_LOAD`, right after
  `ClientWorld` applies the frame in `ON_LOAD`. Every later phase sees the new pose, so game systems,
  `phaser.resolve.offset` and the `phaser.sync.*` systems all run on it in the same frame, whatever
  order the modules were installed in. A `DrawBy` child of a dead-reckoned body follows it without
  lag.
- **Change only.** It writes the pose in place and calls `modified` only when a value changed, and
  allocates nothing per entity per frame. A body at rest is never stepped.
- **Reordering.** A baseline older than the one held is ignored.
- **Body constants.** The damping, center of mass, gravity scale and fast-rotation flag come from
  the entity's `MotionParams`, which the server sends only when they change, in the same frame as
  the `Motion` they belong to; an entity without one has the defaults. When the extrapolator takes a
  newer baseline it copies the entity's `MotionParams` (or the defaults) into its own track and
  steps that baseline with the copy, so a constants update takes effect at the next baseline and
  the per-frame path looks up no component.
- **Rest.** A body is held still, and never stepped, when its baseline says so (`Motion.rest`). The
  server decides it; the client never works it out from the velocities or the gravity. A baseline
  at rest bypasses the integrator: the track holds exactly the baseline's `x`, `y` and `angle`.
- **Corrections.** A baseline received in time, before the client renders past its frame, applies
  at once. A late one blends its error out linearly over `blendMs` (default 100 ms) of render-loop time;
  one that moves the body further than `snapDistance` (default 1 m) or turns it further than
  `snapAngle` (default 0.5 rad) snaps. `blendMs: 0` turns blending off: every correction snaps.
  Longer blends are supported. The module advances one shared blend clock from
  `progress(now, delta)` in milliseconds, so corrections, first-baseline blends and
  hand-off fades finish while `renderFrame` holds, including after a backgrounded tab
  resumes with no further replicated frame arriving.
- **The clock.** The integrator needs the server's `MotionClock`; until it arrives nothing is
  extrapolated.
- **Frames must keep arriving.** `renderFrame` advances only as `ClientWorld` applies frames, and
  holds at the newest one while none arrives, so the extrapolator can only keep a body moving in an
  idle scene if the server keeps sending frames. The server's `DeadReckonedModule` therefore
  requires `keepAliveFrames` on its `ServerWorld` (use `1`), and sends a header-only frame to a
  session that would otherwise get none while a moving body is visible or the last content send is unacknowledged.
  Once idle it pauses by default; `renderFrame` holds. Use render loop time for local effects.
  A server that sends no keepalives while bodies move, such as a custom one, freezes every
  dead-reckoned body at the pose of the last frame, then jumps it when the next frame arrives. See
  [Set `keepAliveFrames: 1`](../vecs-phaser-server/README.md#set-keepaliveframes-1).

`Motion` itself is never interpolated: do not register an interpolator for it.

### Switching paths

The server may switch a body between a streamed pose and a baseline while it lives (see
[Switching at runtime](../vecs-phaser-server/README.md#switching-at-runtime)). The render pose stays
present through the hand-off in both directions, and the difference between the pose the client
showed and the one the new source gives fades out instead of jumping.

- **Present throughout.** The diff in which a streamed body becomes dead reckoned sets `Motion` and
  removes `Position` and `Rotation`. `ClientWorld` skips a network removal of a component that
  another one on the entity brings through `With`, and `Motion` brings `Position` and `Rotation`, so
  they stay: no `remove` or `add` hook fires on them, and `DrawBy` children never see their parent
  lose its `Position` (see
  [Applying a frame](../vecs-client/docs/client-world.md#applying-a-frame)).
- **Streamed to dead reckoned.** The track starts from the pose the entity was showing, and blends
  it out like a late correction. A streamed body whose updates stop holds its last pose until the
  baseline's frame (the switching diff has no `Position` to interpolate toward), so the first
  sample can sit up to about a server frame ahead of the pose just shown. A body that enters the
  view with only a baseline has no pose to start from and never blends.
- **Dead reckoned to streamed.** When `Motion` goes, the track stays for `blendMs` as a hand-off: it
  starts fading at its first rendered sample, preserving the full error on that frame even after a
  render-loop stall, and runs for the full configured duration.
  It adds the difference between the pose the track would still show and the freshly streamed one on
  top of the interpolated `Position` and `Rotation`, fading it linearly to nothing, and then drops
  itself. The track allocates its own output `Position` and `Rotation` once per hand-off and treats
  replication-owned instances as read-only sources, so fading offsets cannot enter interpolation
  history. Without a fresh snapshot it reuses the last source values. At completion its output stays
  attached at the plain streamed pose until the next network value replaces it. A later `Motion`
  starts a fresh track from the pose currently shown, including a hand-off reversed mid-blend.
- **Snaps and steady state.** A difference above `snapDistance` or `snapAngle` shows at once, in
  both directions. An entity in steady state pays nothing for any of this: the hand-off is a second
  system, `phaser.extrapolate.handoff`, whose query holds only the entities in a hand-off.
