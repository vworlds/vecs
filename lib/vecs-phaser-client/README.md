# @vworlds/vecs-phaser-client

The browser side of the vecs Phaser game kit. `PhaserRenderModule` observes a
replicated `ClientWorld` and automatically creates, updates, and destroys
Phaser GameObjects — each live GameObject is attached to its entity **as a
component** (`entity.attach(obj)`), and every sync system dispatches
polymorphically through `Implements` interface markers. All pixel, PPM, and
Y-flip conversion lives here at the Phaser frontier (`CoordSpace`).

Beyond rendering, the package ships four optional modules: `CameraModule`
(server-driven follow/zoom/bounds/shake via the session entity),
`AudioModule` (replicated `Sound`/`Music`), `EffectsModule` (`ParticleBurst`
expansion), and `InputCaptureModule` (keyboard + pointer/touch →
`setInput`). See the guides in
[`../vecs-phaser/docs`](../vecs-phaser/docs/README.md).

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

The `Image` renderer creates textured entities from replicated `Image` components with no
per-entity client code, like the primitive shape renderers.

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
