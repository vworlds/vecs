# @vworlds/vecs-phaser-client

Browser runtime adapter: observes a replicated `ClientWorld` and automatically creates,
updates, and destroys Phaser GameObjects (`PhaserVecsRuntime`, `CoordSpace`). All pixel,
PPM, and Y-flip conversion lives here at the Phaser frontier.

Depends on `@vworlds/vecs-phaser` and `@vworlds/vecs-client`. Requires `phaser@^4.1.0` as
a peer dependency (provided by the application).

## Rotation Interpolation

`ClientWorld` interpolation is configured at construction/connect time. To smooth Phaser
`Rotation` components with shortest-arc angular interpolation, pass `phaserInterpolators()`
when connecting the world:

```ts
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { phaserInterpolators, PhaserVecsRuntime } from "@vworlds/vecs-phaser-client";

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "main",
  networkComponents: phaserNetworkComponents,
  interpolators: phaserInterpolators(),
});

new PhaserVecsRuntime({ world, scene, interpolateRotation: true }).start();
```

Keep `PhaserVecsRuntimeOptions.interpolateRotation` consistent with the
`phaserInterpolators({ interpolateRotation })` argument. Pass
`phaserInterpolators({ interpolateRotation: false })` and runtime
`interpolateRotation: false` to snap rotation updates instead.
