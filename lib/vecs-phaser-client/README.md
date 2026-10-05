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
relationship. The computed resolver reads the `DrawBy` parent and adds `Offset` directly to its
`Position`; it does not use `DrawIn` or apply parent rotation.

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
