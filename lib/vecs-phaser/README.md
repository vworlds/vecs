# @vworlds/vecs-phaser

Data-only package for the vecs Phaser game kit: 35 wire-serializable
components — transforms, shapes, `Text`, `Image`, animated `Sprite`,
parenting relationships, display state (`Hidden`, `Flip`, `Origin`,
`ScreenAnchor`, `Tint`), server-driven camera components, audio
(`Sound`/`Music`), and `ParticleBurst` — plus the `phaserNetworkComponents`
protocol order (**the order is the wire protocol**; append-only).

Also exports the shared asset-catalog schema (`AssetCatalog`,
`SpritesheetDescriptor` with tile animations, `AudioDescriptor`) and the
input contract (`InputPayload`, `actionMask`/`hasAction`). No `phaser`
dependency.

Depends on `@vworlds/vecs` and `@vworlds/vecs-wire`.

- **Guides:** [`./docs`](./docs/README.md) — start with
  [getting started](./docs/getting-started.md) and the
  [design guide](./docs/design-guide.md).
- **Architecture:** [`./architecture/README.md`](./architecture/README.md).
- **Reference demo:** Tank Arena
  ([`apps/demo-server`](../../apps/demo-server/README.md) +
  [`apps/demo-client`](../../apps/demo-client/README.md)).
- Forward-looking work: repo [`ROADMAP.md`](../../architecture/ROADMAP.md).
