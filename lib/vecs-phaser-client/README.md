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
