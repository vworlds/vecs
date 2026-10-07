# @vworlds/vecs-phaser-server

Server helpers for vecs-backed Phaser worlds. `PhaserServerModule`, when installed on a
`ServerWorld`, marks `DrawIn` and `DrawBy` as single-target (`Exclusive`) relationships, marks only
`DrawBy` as `Traversable`, makes the renderable components mutually exclusive
(`setExclusiveComponents(...phaserRenderableComponents)` — one shape per entity) and installs
two reactive `POST_UPDATE` pose-sync systems that copy `vecs-physics` `Position`/`Rotation`
into the render `Position`/`Rotation` whenever the physics body pose changes. No `phaser`
dependency.

The sync systems (`phaser.sync.position` and `phaser.sync.rotation`) write a render component only
when it differs from the physics value, compared field by field with exact equality, both when the
physics pose changes and when an entity enters. They never create the render component. Every `set`
marks a component modified and replicates a networked one, so a body that does not move or turn
rewrites, and therefore re-sends, nothing: a bullet flying straight keeps its constant render
`Rotation` out of the network.

Create display edges with `entity.add(DrawIn, parent)` or `entity.add(DrawBy, parent)`. Relationship
targets are not component payload properties, and the server module does not make the two display
relationship component types mutually exclusive; `DisplaySetupModule` applies that local invariant
on clients.

Depends on `@vworlds/vecs-phaser`, `@vworlds/vecs-server`, and `@vworlds/vecs-physics`.

`AssetManager` owns the server-side Tiled tileset catalog. Construct it with
`new AssetManager({ assetsPath })` to scan and load every supported asset under `assetsPath`, then
call `getTileset(key)` to get a typed `TilesetAsset` with frame dimensions, `tile(id)` metadata,
and `sizeInMeters(ppm)` for matching physics bodies to art. `mount(app, worldName)` serves the
catalog JSON and static image files over the same Express app. The Tiled schema used for ingestion
is vendored and minimal; there is no `@kayahr/tiled` runtime dependency.
