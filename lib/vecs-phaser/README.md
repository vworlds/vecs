# @vworlds/vecs-phaser

Data-only package providing wire-serializable Phaser render components (`Position`, `Arc`,
`Text`, `Image`, …) and the `phaserNetworkComponents` protocol order. `Image` is the first
textured renderable and is protocol type 17. No `phaser` dependency.

Also exports the shared asset catalog schema (`AssetDescriptor`, `SpritesheetDescriptor`,
`AssetCatalog`) used by `@vworlds/vecs-phaser-server` to describe server-owned assets and by
`@vworlds/vecs-phaser-client` to load them before rendering.

Depends on `@vworlds/vecs` and `@vworlds/vecs-wire`.

See [`./architecture/README.md`](./architecture/README.md) for the full design.
Forward-looking work lives in the repo [`ROADMAP.md`](../../architecture/ROADMAP.md).
