# @vworlds/vecs-phaser

Data-only package providing wire-serializable Phaser render components (`Position`, `Arc`,
`Text`, `Image`, …) and the `phaserNetworkComponents` protocol order. `Image` is the first
textured renderable and is protocol type 17. `OpenPath` (type 23) is a tag that leaves the stroke
of an `Arc` or `Polygon` open, for progress rings and polylines. No `phaser` dependency.

The protocol also includes `DrawIn` for native Phaser Container parenting and `DrawBy` for
computed scene-root parenting. Both are networked relationship classes. `DisplaySetupModule` and
`PhaserServerModule` configure them as single-target (`Exclusive`) relationships in their worlds;
client setup also makes `DrawBy` traversable, while `DrawIn` is not.

A `DrawBy` child follows its parent's `Position` only: the `Offset` is added as is and the child's
own `Rotation` stays independent. `InheritRotation` is an opt-in tag that puts the child in its
parent's local frame instead, so the `Offset` turns with the parent and the child's `Rotation` is
the parent's angle plus the tag's `angle`. The tag is a wire type but deliberately not part of
`phaserNetworkComponents`, because that list's order is the protocol and appending to it shifts the
wire ids of every application component listed after it. It is client-local by default; an
application that wants the server to set it lists it in its own network components, after its
existing ones.

Also exports the shared asset catalog schema (`AssetDescriptor`, `SpritesheetDescriptor`,
`AssetCatalog`) used by `@vworlds/vecs-phaser-server` to describe server-owned assets and by
`@vworlds/vecs-phaser-client` to load them before rendering.

Depends on `@vworlds/vecs` and `@vworlds/vecs-wire`.

See [`./architecture/README.md`](./architecture/README.md) for the full design.
Forward-looking work lives in the repo [`ROADMAP.md`](../../architecture/ROADMAP.md).
