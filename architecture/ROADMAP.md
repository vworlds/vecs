# Vecs Roadmap

Forward-looking planning for the Vecs suite. Completed work belongs in
[`CHANGELOG.md`](./CHANGELOG.md), not here.

## Version +1

Planned features for the next version.

- [vecs-physics] **Fixed-step driver** — add a small real-time accumulator helper so games can drive deterministic physics without hand-rolling the `requestAnimationFrame` to fixed-timestep bridge.
- [vecs-physics] **Joints** — add the next major physics surface with a second cross-entity relationship model (`JointBodies`) plus per-type joint components.
- [vecs-physics] **Open-chain sharp-endpoint ghost vertices** — replace the reflection approximation at open-chain endpoints with real Box2D ghost-vertex parity so sharp endpoints collide correctly; loop chains already use real neighbor ghosts.
- [vecs] **Injected mutation dirty tracking** — make `.each`/`.update`-injected component mutation reliably mark components modified, or provide an explicit ergonomic replacement if automatic tracking is not viable.
- [vecs-phaser] **Dynamic assets** — add an in-band "asset added" message that extends the `AssetCatalog` at runtime and triggers a Phaser load before the referencing entity renders. The append-only wire id space and id-only wire encoding already ship, so this lands without a protocol break.
- [vecs-phaser-server] **Physics-matched collision from Tiled objects** — build `vecs-physics` bodies from the captured Tiled `objectgroup` shapes so collision matches the art; `TilesetAsset.sizeInMeters` already covers the simple rectangular case.
- [vecs-phaser-server] **Full Tiled maps** — parse `.tmj` tile-layer layout in addition to the standalone single-image `.tsj` tilesets already ingested.
- [vecs-phaser-server] **Image-collection tilesets** — support tilesets where individual tiles carry their own `image` (currently rejected by a scope guard).
- [vecs-phaser-client] **Multi-scene rendering** — support multiple Phaser scenes with `Scene`/`InScene` networking, building on the single-scene MVP.
- [vecs-phaser-client] **Spatial audio** — distance-based attenuation/panning for replicated `Sound`/`Music`, building on the shipped audio pipeline.

## Version +2

Planned features for the subsequent version.

- [vecs-physics] **Character movers** — build character-movement primitives (Box2D mover-style helpers) on top of the shipped ray-cast and shape-cast query foundation.
- [vecs-physics] **Debug draw bridge** — provide geometry callbacks that let callers render Box2D debug data through their own renderer.
- [vecs-physics] **World teardown and serialization** — add explicit Box2D world destruction, pool cleanup, and a rebuild-from-components load path.
- [vecs-physics] **Per-segment chain materials** — let each chain segment carry its own surface material (friction, restitution, rolling resistance, tangent speed) via Box2D's `materials[]`/`materialCount` chain def, instead of one uniform material per chain.
- [vecs-physics] **In-place chain material updates** — bind `b2Chain_SetSurfaceMaterial` in box2d3-wasm and use it to mutate chain materials without recreating the whole chain, the way single shapes already use `b2Shape_SetSurfaceMaterial`.
- [vecs] **Suite-level save/load contracts** — define how core entities, relationships, protocol state, and package-specific components participate in persisted worlds.
- [vecs-phaser-client] **Renderer batching pass** — reduce Phaser object churn and update cost once the render surface settles around primitives, sprites, UI, and effects.
