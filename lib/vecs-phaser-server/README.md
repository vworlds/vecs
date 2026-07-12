# @vworlds/vecs-phaser-server

Server helpers for vecs-backed Phaser worlds. `PhaserServerModule`, when installed on a
`ServerWorld`, makes the renderable components mutually exclusive
(`setExclusiveComponents(...phaserRenderableComponents)` — one shape per entity) and installs
two reactive `POST_UPDATE` pose-sync systems that copy `vecs-physics` `Position`/`Rotation`
into the render `Position`/`Rotation` whenever the physics body pose changes. No `phaser`
dependency.

Depends on `@vworlds/vecs-phaser`, `@vworlds/vecs-server`, and `@vworlds/vecs-physics`.

`AssetManager` owns the server-side asset catalog. Construct it with
`new AssetManager({ assetsPath })` to scan every supported asset under `assetsPath`:
`getTileset(key)` returns a typed `TilesetAsset` (frame dimensions, `tile(id)` metadata
including animations, `sizeInMeters(ppm)` for matching physics bodies to art) and
`getAudio(key)` a typed `AudioAsset`. `mount(app, worldName)` serves the catalog JSON and
static files over the same Express app. The Tiled schema used for ingestion is vendored and
minimal; there is no `@kayahr/tiled` runtime dependency.

Also ships the gameplay-side helpers: `InputDecodeModule` decodes and sanitizes the raw
`NetworkInput` blob into the typed `PlayerInput` component on each session entity, and
`Lifetime`/`LifetimeModule` provide the server-local countdown that drives one-shot effect
entities. See the guides in [`../vecs-phaser/docs`](../vecs-phaser/docs/README.md).
