# @vworlds/vecs-phaser-client

Browser render adapter: registers a vecs module that observes a replicated `ClientWorld`
and automatically creates, updates, and destroys Phaser GameObjects. Each live Phaser
GameObject is attached to its entity **as a component** (`entity.attach(obj)`), and the
renderer dispatches transform/style updates polymorphically through `Implements` interface
markers (`GameObject`, `Transform`, `Fill`, …). All pixel, PPM, and Y-flip conversion lives
here at the Phaser frontier.

Depends on `@vworlds/vecs-phaser` and `@vworlds/vecs-client`. Requires `phaser@^4.1.0` as
a peer dependency (provided by the application).

## Rotation Interpolation

`ClientWorld` interpolation is configured at construction/connect time. To smooth Phaser
`Rotation` components with shortest-arc angular interpolation, pass `phaserInterpolators()`
when connecting the world:

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

Rotation interpolation is a connect-time concern. Pass
`phaserInterpolators({ interpolateRotation: false })` to snap rotation updates instead.
