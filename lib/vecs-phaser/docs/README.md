# vecs-phaser documentation

Guides for the Phaser trio — `@vworlds/vecs-phaser` (wire components),
`@vworlds/vecs-phaser-client` (browser render/camera/audio/input modules), and
`@vworlds/vecs-phaser-server` (server glue, assets, input decode). Together
they turn replicated vecs ECS state into a running 2D multiplayer game with
almost no client code.

New here? Read [Getting started](./getting-started.md), then the
[design guide](./design-guide.md) for how to structure a real game. The ECS
itself is documented in [`lib/vecs/docs`](../../vecs/docs/README.md) and the
physics engine in [`lib/vecs-physics/docs`](../../vecs-physics/docs/index.md).

## Reading order

| Guide                                             | What it covers                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Getting started](./getting-started.md)           | A minimal server + client pair: first renderable entity on screen.                                               |
| [Components](./components.md)                     | Every networked component with wire ids, fields, and units — the protocol reference.                             |
| [Rendering](./rendering.md)                       | How the client render module works: coordinate model, interface markers, GameObject-as-component lifecycle.      |
| [Parenting](./parenting.md)                       | Display hierarchies: `DrawIn` (native containers), `DrawBy` (computed), `Offset`, `Container`.                   |
| [Assets](./assets.md)                             | The server-owned catalog: Tiled tilesets, audio files, HTTP serving, `loadAssets`.                               |
| [Sprites & animation](./sprites-and-animation.md) | Animated `Sprite` renderables driven by Tiled tileset animations.                                                |
| [Audio](./audio.md)                               | One-shot `Sound` and looping `Music`, replicated like everything else.                                           |
| [Camera & screen-space UI](./camera-and-ui.md)    | Server-driven cameras (`CameraFollow`/`Zoom`/`Bounds`/`Shake`), `ScreenAnchor` HUDs, `Origin`, `Hidden`, `Flip`. |
| [Input](./input.md)                               | The input toolkit: client capture (keyboard/pointer/touch) → sanitized server `PlayerInput`.                     |
| [Effects](./effects.md)                           | One-shot `ParticleBurst` entities and the server `Lifetime` helper.                                              |
| [Networking](./networking.md)                     | Interpolation, interest management, the session handshake, and the protocol append rules.                        |
| [Design guide](./design-guide.md)                 | Opinionated: how to structure a small multiplayer game on this stack.                                            |

The implemented architecture (decisions, invariants, testing strategy) lives
in [`../architecture/README.md`](../architecture/README.md). The runnable
reference is the **Tank Arena** demo:
[`apps/demo-server`](../../../apps/demo-server/README.md) +
[`apps/demo-client`](../../../apps/demo-client/README.md).
