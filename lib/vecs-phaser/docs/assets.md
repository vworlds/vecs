# Assets

The server owns all assets. It ingests metadata at boot, assigns each asset
a stable numeric id, serves a per-world **catalog** (JSON) plus the files
over HTTP, and refers to assets on the wire **by id only**. The client
fetches the catalog and loads everything before the world connects.

## Server: `AssetManager`

```ts
import { AssetManager } from "@vworlds/vecs-phaser-server";

const assets = new AssetManager({ assetsPath: "assets" }); // scans at construction
const ship = assets.getTileset("ship"); // assets/tilesets/ship.tsj (.json fallback)
const boom = assets.getAudio("explosion"); // assets/audio/explosion.(ogg|mp3|wav|m4a)
assets.mount(app, world.name); // GET …/assets (catalog) + …/assets/files/* (bytes)
```

- **Tilesets** (`assets/tilesets/*.tsj`): single-image Tiled tilesets,
  published to the client as Phaser spritesheets. The typed `TilesetAsset`
  handle exposes frame dimensions, `sizeInMeters(ppm)` (match a physics body
  to the art in one call), and per-tile Tiled metadata via `tile(id)` —
  `class`, typed `properties`, collision `objects`, and `animation` frames.
  Tiled tile ids and Phaser frame indices are both row-major, so
  **tile id == frame index**.
- **Audio** (`assets/audio/*`): metadata-only `AudioAsset` handles
  (`{ id, file }`); bytes are served by `mount`, decoded by the browser.
- Ids are server-assigned, stable, and append-only; the human key
  (`"ship"`) never crosses the wire.

Use the ids in components:

```ts
world
  .entity()
  .add(Networked)
  .set(Sprite, { texture: ship.id, frame: 4 })
  .set(Size, ship.sizeInMeters(PPM)); // { w, h } → width/height in meters
```

## Catalog schema (`@vworlds/vecs-phaser`)

`AssetCatalog { worldName, assets: AssetDescriptor[] }`, where each
descriptor narrows by `kind`:

- `SpritesheetDescriptor` — image path + frame geometry + `animations`
  (per-tile frame lists with authored millisecond durations, straight from
  Tiled — see [Sprites & animation](./sprites-and-animation.md)).
- `AudioDescriptor` — `{ id, kind: "audio", file }`.

New kinds append a new `*Descriptor extends AssetDescriptor`; the base never
changes. The catalog travels as JSON over HTTP — the binary channel stays
state-only.

## Client: `loadAssets`

```ts
const catalog = await loadAssets(scene, {
  host,
  port,
  worldName,
  onProgress: (value) => bar.setSize(4 + value * 240, 12),
});
// …then connect and pass the catalog to the render module:
world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100, catalog });
```

`loadAssets` fetches the catalog, queues every spritesheet and audio file in
Phaser's loader (textures and sounds are keyed by the numeric id), registers
every tileset animation as `"<assetId>:<tile>"`, and resolves only when the
loader completes — so **no state diff can ever reference an unloaded
asset**. The idiomatic structure is a boot scene that awaits `loadAssets`
and then starts the game scene with the catalog (see the
[Tank Arena client](../../../apps/demo-client/src/main.ts)).

## Reference

| API                                      | Package            | Purpose                                        |
| ---------------------------------------- | ------------------ | ---------------------------------------------- |
| `AssetManager({ assetsPath })`           | vecs-phaser-server | Scan + load all assets, assign ids.            |
| `getTileset(key)` / `getAudio(key)`      | vecs-phaser-server | Typed handles; throw typed not-found errors.   |
| `mount(app, worldName, apiBasePath?)`    | vecs-phaser-server | Serve catalog JSON + static files.             |
| `toCatalog(worldName)`                   | vecs-phaser-server | Build the DTO (server-only metadata stripped). |
| `loadAssets(scene, options)` → `Catalog` | vecs-phaser-client | Fetch, load, register animations, resolve.     |
| `Catalog.get(id)` / `has(id)` / `all()`  | vecs-phaser-client | Id → descriptor lookup.                        |
