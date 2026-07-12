# Getting started

Build the smallest possible vecs-phaser game: an authoritative server that
owns one entity, and a browser client that renders it — with zero per-entity
render code.

## The mental model

The server owns every entity and describes it with small **render
components** in meters (`Position`, `Arc`, `FillStyle`, …). The client
receives those components through `@vworlds/vecs-client` and the
`PhaserRenderModule` turns them into live Phaser GameObjects automatically:
create on arrival, mutate on change, destroy on removal. The server says
_what exists, where it is, and what it looks like_; the client owns the
Phaser lifecycle.

## Server

```ts
import express from "express";
import { phaserNetworkComponents, Arc, FillStyle, Position } from "@vworlds/vecs-phaser";
import { PhaserServerModule } from "@vworlds/vecs-phaser-server";
import { Networked, ServerWorld, VecsListener } from "@vworlds/vecs-server";

const world = new ServerWorld({ name: "main", networkComponents: phaserNetworkComponents });
world.module(PhaserServerModule); // exclusivity + physics→render pose sync

// One yellow ball at (1, 0.5) — meters, +y up, origin at the arena center.
world
  .entity()
  .add(Networked)
  .set(Position, { x: 1, y: 0.5 })
  .set(Arc, { radius: 0.25 })
  .set(FillStyle, { color: 0xffcc00 });

const app = express();
const listener = new VecsListener();
listener.registerWorld(world);
await listener.listen(app, { ordered: false, maxRetransmits: 2 });
app.listen(3000);

// Drive ticks yourself (30 Hz here); deltas are milliseconds.
setInterval(() => world.progress(performance.now(), 1000 / 30), 1000 / 30);
```

Two things to remember:

- Only entities with `Networked` replicate, and only to clients whose `View`
  matches them — set `View { dsl: true }` on each session entity to show
  everything (see [Networking](./networking.md)).
- `networkComponents` **is the wire protocol**. Use `phaserNetworkComponents`
  on both ends and never reorder it.

## Client

```ts
import Phaser from "phaser";
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { PhaserRenderModule, phaserInterpolators } from "@vworlds/vecs-phaser-client";

class GameScene extends Phaser.Scene {
  private world?: ClientWorld;

  public create(): void {
    void ClientWorld.connectDgram({
      host: "localhost",
      port: 3000,
      worldName: "main",
      networkComponents: phaserNetworkComponents,
      interpolators: phaserInterpolators(), // smooth Position/Rotation
    }).then((world) => {
      world.module(PhaserRenderModule, { scene: this, pixelsPerMeter: 100 });
      this.world = world;
    });
  }

  public override update(time: number, delta: number): void {
    this.world?.progress(time, delta); // applies diffs + runs render systems
  }
}

new Phaser.Game({ width: 960, height: 540, scene: [GameScene], parent: "game" });
```

That's a complete client. The yellow ball appears centered-right of the
canvas; if the server moves it (`entity.set(Position, …)`), it glides.

When the server uses textures or audio, load the asset catalog **before**
connecting — see [Assets](./assets.md) for the `loadAssets` boot-scene
pattern.

## Where to go next

- Add gameplay: [Input](./input.md) (client capture → server `PlayerInput`).
- Make the world bigger than the screen: [Camera](./camera-and-ui.md).
- Structure a real game: the [design guide](./design-guide.md) and the
  [Tank Arena demo](../../../apps/demo-server/README.md).
