# @vworlds/vecs-phaser-server

Thin, zero-config pure-ECS server helper. Exports a single `PhaserServerModule` that, when
installed on a `ServerWorld`, makes the renderable components mutually exclusive
(`setExclusiveComponents(...phaserRenderableComponents)` — one shape per entity) and installs
two reactive `POST_UPDATE` pose-sync systems that copy `vecs-physics` `Position`/`Rotation`
into the render `Position`/`Rotation` whenever the physics body pose changes. No `phaser`
dependency.

Depends on `@vworlds/vecs-phaser`, `@vworlds/vecs-server`, and `@vworlds/vecs-physics`.
