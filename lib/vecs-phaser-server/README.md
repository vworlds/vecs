# @vworlds/vecs-phaser-server

Server helpers for vecs-backed Phaser worlds. `PhaserServerModule`, when installed on a
`ServerWorld`, makes the renderable components mutually exclusive
(`setExclusiveComponents(...phaserRenderableComponents)` — one shape per entity) and installs
two reactive `POST_UPDATE` pose-sync systems that copy `vecs-physics` `Position`/`Rotation`
into the render `Position`/`Rotation` whenever the physics body pose changes. No `phaser`
dependency.

Depends on `@vworlds/vecs-phaser`, `@vworlds/vecs-server`, and `@vworlds/vecs-physics`.

`AssetManager` owns the server-side Tiled tileset catalog. Construct it with
`new AssetManager({ assetsPath })` to scan and load every supported asset under `assetsPath`, then
call `getTileset(key)` to get a typed `TilesetAsset` with frame dimensions, `tile(id)` metadata,
and `sizeInMeters(ppm)` for matching physics bodies to art. `mount(app, worldName)` serves the
catalog JSON and static image files over the same Express app. The Tiled schema used for ingestion
is vendored and minimal; there is no `@kayahr/tiled` runtime dependency.
