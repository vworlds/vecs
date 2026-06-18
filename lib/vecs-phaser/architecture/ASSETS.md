# vecs-phaser — Images & Asset Catalog (v1)

**Status:** approved design, pre-implementation
**Audience:** engineering manager + implementing subagents
**Companion:** [`TICKETS.md`](./TICKETS.md) — delegate-ready ticket breakdown (VPH-60+)
**Builds on:** [`README.md`](./README.md) — the shipped primitive-shape render layer; this
feature is the first post-MVP work named there ("`Image`/`Sprite` and asset-loading protocol").

---

## 1. Intent

Let the **server own an asset catalog** and refer to assets on the wire by short **numeric
resource ids**, while the **thin client** downloads every asset over HTTP before the world
starts and renders textured entities with **no per-entity render code** — exactly like the
existing shape renderers.

v1 ships **static images** (a Phaser `Image` GameObject) sourced from raw image files _or_
from **Tiled tilesets** ingested as spritesheets. The wire never carries paths or strings:
"show frame `f` of resource `#id`" is two numbers.

The design deliberately leaves the door open for two later features without a protocol break:

- **Dynamic assets** — assets created at runtime while the world is already playing.
- **Animated sprites** — a separate `Sprite` renderable that reuses the same catalog.

### Non-goals (v1)

Full Tiled **maps** (`.tmj` tile-layer layout), **image-collection** tilesets (one image per
tile), **texture atlases** with named frames, **audio**, **animation playback**, **tinting**,
runtime/dynamic asset creation, and bundling assets into the client build. None of these are
precluded by the architecture; they are simply out of scope for the first version.

---

## 2. Verified facts (source of truth)

Confirmed by reading the code and the Tiled/Phaser references; implementers can rely on these.

| Fact                                                                                                                                               | Where                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Network type id = `phaserNetworkComponents` index + 1; **order is the protocol**                                                                   | `lib/vecs-phaser/src/index.ts`, `lib/vecs-protocol/src/network_world.ts`     |
| Renderable exclusivity is one component from `phaserRenderableComponents`                                                                          | `lib/vecs-phaser/src/index.ts`, `PhaserServerModule`                         |
| Wire scalars include `u16`/`u32`; ids already pack into `u32` (`cid_pack`)                                                                         | `lib/vecs-wire/src/decorators.ts`, `lib/vecs-protocol/src/cid.ts`            |
| The client adapter creates/updates/destroys Phaser GameObjects from a local `VGameObject`; PPM/Y-flip live only in `CoordSpace`                    | `lib/vecs-phaser-client/src/sync.ts`, `coord_space.ts`                       |
| Shared transform/style sync targets any `VGameObject` (Position, Rotation, Scale, Alpha, Depth)                                                    | `lib/vecs-phaser-client/src/modules/sync.ts`                                 |
| The dgram transport is WebRTC datachannel with **HTTP signaling mounted on the app's Express instance**                                            | `node_modules/@vworlds/dgram-server/.../socket-listener.js`                  |
| `connectDgram` performs an HTTP handshake against `worldPath(apiBasePath, worldName)` before the channel opens                                     | `lib/vecs-client/src/client_world.ts:105`                                    |
| The server already owns an Express `app` and CORS; the dgram listener mounts onto it                                                               | `apps/server/src/main.ts:130`, `lib/vecs-server/src/vecs_listener.ts`        |
| Phaser: `scene.load.spritesheet(key, url, { frameWidth, frameHeight, margin, spacing })`; frames are row-major numeric                             | `/tmp/phaser/src/loader/filetypes/SpriteSheetFile.js`                        |
| Phaser: `scene.add.image(x, y, key, frame)` / `image.setTexture(key, frame)` / `setDisplaySize(w, h)`                                              | `/tmp/phaser/src/gameobjects/image/ImageFactory.js`, `components/Texture.js` |
| Tiled standalone tileset (`.tsj`): `image`, `imagewidth/height`, `tilewidth/height`, `margin`, `spacing`, `columns`, `tilecount`, sparse `tiles[]` | https://doc.mapeditor.org/en/stable/reference/json-map-format/               |
| Tiled tile local id ordering is **row-major** → tile id == Phaser spritesheet frame index                                                          | Tiled JSON reference; Phaser SpriteSheetFile                                 |
| `@kayahr/tiled` is MIT, pure-TS, supplies `Tileset`/`Tile`/`Property` interfaces + type guards                                                     | https://github.com/kayahr/tiled                                              |

---

## 3. Locked design decisions

1. **Catalog over HTTP, not the binary wire.** The server serves a per-world catalog JSON;
   the client fetches it and drives the Phaser loader. The datachannel stays state-only.
2. **Phaser-scoped resource layer.** Schema/contract in `vecs-phaser` (no `phaser` dep);
   catalog ownership, Tiled ingestion, dimension probing, and HTTP serving in
   `vecs-phaser-server`; loader integration and rendering in `vecs-phaser-client`.
3. **Author key → server-assigned numeric id.** Code refers to assets by a human key
   (`"ship"`); the server assigns a stable numeric id and owns the `key ↔ id ↔ url` map. The
   wire carries only the number. The client registers Phaser textures keyed by the **id**, so
   the author key never reaches the client.
4. **Sizing is "Both."** `Size` (meters) present → `setDisplaySize` via PPM; absent → the
   texture's **native pixels ÷ PPM** (a 200×200 source at PPM 100 is a 2 m × 2 m object).
   Origin is `0.5` (center), matching every other renderable and Box2D body transforms.
5. **Server knows intrinsic pixel dimensions.** Because it owns the files, the catalog builder
   probes them at build time. A `sizeInMeters(key, ppm)` helper makes "size this physics body
   to match the art" a one-liner. PPM stays off the wire (still meters everywhere).
6. **`Image` renderable, backed by a Phaser `Image`.** Component `Image { texture, frame }`,
   appended to the protocol as **type 17**. No tint, no animation in v1. Animation later lands
   on a _separate_ `Sprite` renderable, not this one.
7. **Load-then-start.** `await loadAssets(...)` resolves only when every asset is loaded, so no
   diff can reference an unloaded texture. Enforced by ordering, not by per-frame guards.
8. **Append-only id space.** Ids are server-assigned and never reused or reordered, so a future
   in-band "asset added" message can extend the catalog at runtime without disturbing v1.

---

## 4. Catalog model

The catalog is the shared contract between server and client. It travels as **JSON over
HTTP** (so its types carry no `@wireType`), and it lives in `vecs-phaser` so both ends agree.

```ts
// @vworlds/vecs-phaser  (data-only, no phaser dep)
export type AssetDescriptor =
  | {
      id: number; // wire id (stable, append-only)
      key: string; // author key, authoring/debug only
      kind: "image";
      url: string; // HTTP url the client loads from
      pixelWidth: number;
      pixelHeight: number;
    }
  | {
      id: number;
      key: string;
      kind: "spritesheet";
      url: string;
      frameWidth: number;
      frameHeight: number;
      margin: number;
      spacing: number;
      columns: number;
      tileCount: number;
      imageWidth: number;
      imageHeight: number;
    };

export interface AssetCatalog {
  worldName: string;
  assets: AssetDescriptor[];
}
```

A tileset becomes a `"spritesheet"` descriptor. **Per-tile Tiled metadata (properties,
animations, collision shapes) is intentionally excluded** from the catalog DTO — it is
server-only game-logic data; the client only ever needs `(id, frame)` to render.

---

## 5. Component specification

`vecs-phaser` gains one networked component and reuses the existing `Size`.

```ts
/** Textured renderable. Both fields index the asset catalog. */
export class Image {
  /** Resource id of the source texture (image or spritesheet). */
  @wireType("u32")
  public texture = 0;

  /** Frame index within a spritesheet/tileset; 0 for a single image. */
  @wireType("u16")
  public frame = 0;
}
```

- Appended to `phaserNetworkComponents` as **type 17** (deliberate protocol bump; the order
  snapshot test must be updated in the same change) and added to `phaserRenderableComponents`
  so exclusivity treats it as one-of the renderables.
- **Sizing:** if the entity also carries `Size` (meters), the renderer calls
  `setDisplaySize(coords.len(width), coords.len(height))`; otherwise it leaves Phaser's native
  frame size and the on-screen meters fall out of `nativePx ÷ PPM`.
- **Transform/style reuse:** `Position`, `Rotation`, `Scale`, `Alpha`, `Depth` already sync to
  any `VGameObject` and apply unchanged. `FillStyle`/`StrokeStyle` do not target `Image`.

---

## 6. Package architecture

```
@vworlds/vecs-phaser            Image component + AssetDescriptor/AssetCatalog types
        │  (data-only, no phaser dep)
        ▼
@vworlds/vecs-phaser-server     AssetManager: register/probe/ingest, sizeInMeters, serve
        │  deps add: @kayahr/tiled (types), image-size (probing), express (peer)
        ▼
@vworlds/vecs-phaser-client     loadAssets(scene, conn) + Image renderer (peer: phaser)
```

> **Note (intentional):** this expands `vecs-phaser-server` beyond its current "thin pure-ECS,
> no deps" character. Adding file probing, Tiled ingestion, and HTTP serving is the point — the
> server owns the asset catalog.

### 6.1 Server — `AssetManager` (the authoring contract)

```ts
const assets = new AssetManager({ baseDir: "assets" });

assets.image("ship", "ship.png"); // probes 200×200 from disk
assets.image("logo", "logo.svg", { width: 128, height: 64 }); // SVG render size required
assets.spritesheet("boom", "boom.png", { frameWidth: 64, frameHeight: 64 });
assets.tileset("terrain", "terrain.tsj"); // ingests Tiled JSON → spritesheet entry + tile metadata

assets.id("ship"); // → number for the Image component / wire
assets.sizeInMeters("ship", PPM); // → { width: 2, height: 2 }  (physics-body matching)
assets.tile("terrain", 5)?.properties; // → { solid: true, ... }  (server-only)
assets.toCatalog(world.name); // → AssetCatalog DTO (server-only metadata stripped)
assets.mount(app); // GET {worldPath}/assets (catalog) + static asset files
```

- **Probing:** raster files (`png`/`jpg`/`webp`/`gif` first frame) → dimensions read from the
  file header via `image-size`. **SVG** is vector and has no intrinsic pixel size, so the
  author must declare a render size; that size is both the loader rasterization size and the
  meter mapping. Spritesheet/tileset frame dimensions come from config/Tiled, not probing.
- **Serving:** mounts on the same Express `app` the server already owns, under the existing
  per-world `worldPath(apiBasePath, worldName)`. CORS is already configured at the app level.
- **Usage in game code:**
  ```ts
  world
    .entity()
    .add(Networked)
    .set(Image, { texture: assets.id("ship"), frame: 0 });
  ```

### 6.2 Server — Tiled tileset ingestion

`assets.tileset(key, tsjPath)`:

1. `JSON.parse` the `.tsj`/`.json`, typed via `@kayahr/tiled` (`Tileset`/`Tile`/`Property`).
2. Resolve the tileset's `image` path **relative to the `.tsj` location**; register that file
   for serving.
3. Emit a `"spritesheet"` descriptor: `frameWidth = tilewidth`, `frameHeight = tileheight`,
   plus `margin`, `spacing`, `columns`, `tileCount`, `imageWidth`, `imageHeight`.
4. Store the sparse `tiles[]` metadata **server-side** keyed by tile id: `properties` (used by
   v1 game logic), `animation` and `objectgroup` (captured now, consumed by later features).

Because Tiled tile ids and Phaser spritesheet frame indices are both row-major,
**tile id == frame**, so `set(Image, { texture: assets.id("terrain"), frame: tileId })` shows
that exact tile, and `assets.tile("terrain", tileId)` returns its metadata.

Scope guards for v1: **single-image** tilesets only (reject/relegate image-collection
tilesets, where tiles carry their own `image`); **tilesets only** (no `.tmj` map parsing).

### 6.3 Client — `loadAssets` + Image renderer

```ts
const catalog = await loadAssets(scene, { host, port, worldName }); // fetch → load all → resolve on complete
const world = await ClientWorld.connectDgram({
  host,
  port,
  worldName,
  networkComponents: phaserNetworkComponents,
  interpolators: phaserInterpolators(),
});
world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100, catalog });
```

- `loadAssets` fetches `{worldPath}/assets`, then for each descriptor queues
  `scene.load.image(String(id), url)` or
  `scene.load.spritesheet(String(id), url, { frameWidth, frameHeight, margin, spacing })`,
  calls `scene.load.start()`, and resolves a `Catalog` (an `id → descriptor` lookup) on the
  loader `complete` event. It surfaces the loader's progress for a loading bar.
- The **Phaser texture key is the resource id** (`String(id)`), so the renderer maps
  `Image.texture` → key with no author-key knowledge.
- New `src/modules/image.ts` mirrors the shape renderers:
  - `phaser.new.image`: `.with(Image).without(VGameObject)` → `scene.add.image(0, 0,
String(texture), frame)`, `setOrigin(0.5)`, set `VGameObject`.
  - `phaser.render.image`: `.with(Image, VGameObject)` → on `texture`/`frame` change call
    `setTexture(String(texture), frame)`; size from `Size` (→ `setDisplaySize`) or native;
    `.exit` removes `VGameObject` (its remove hook destroys the Phaser object).
- The render module accepts the resolved `catalog` so it can validate ids and (later) resolve
  descriptor metadata; rendering itself needs only the texture key + frame.

---

## 7. Load-then-start ordering

`loadAssets` is awaited **before** `connectDgram`, guaranteeing every texture is resident
before the first state diff arrives. The **default app structure is a dedicated boot/loading
scene** (idiomatic Phaser), which also gives a natural home for the load progress UI:

1. **Dedicated boot/loading scene (v1 default).** A lightweight `BootScene` does
   `await loadAssets(scene, conn)` (rendering loader progress as a bar), then
   `this.scene.start("Game", { catalog })` once everything is resident; the game scene connects
   the world and registers `PhaserRenderModule` with the passed catalog. This is the idiomatic
   Phaser loading-screen pattern, scales to large catalogs, and keeps the gameplay scene free of
   load bookkeeping. The Phaser loader runs via `load.start()` (not the conventional `preload()`)
   because the catalog must be _fetched_ before the loads can be queued.
2. **Await in `create()` (simplest, single-scene).** The gameplay scene's `create()` does
   `await loadAssets(...)` then connects. Fine for a throwaway/single-scene app; offers no
   loading-screen seam. No library change — `loadAssets` is the same call either way.

This is purely a "where does it run" choice; it does not affect the wire, the catalog, or the
renderer.

---

## 8. Forward-compatibility (no protocol break)

- **Dynamic assets:** ids are server-assigned and append-only, and the wire only carries ids.
  A later in-band "asset added" message can extend the `AssetCatalog` at runtime and trigger a
  Phaser load before the referencing entity renders. v1 builds none of this but precludes none.
- **Animated sprites:** a future `Sprite` renderable (its own `phaserNetworkComponents` entry)
  reuses the same catalog and the captured Tiled `animation` frames. `Image` stays the static
  path.
- **Physics-matched collision:** captured Tiled `objectgroup` shapes can later build
  vecs-physics bodies that match the art; `sizeInMeters` covers the simple rectangular case now.

---

## 9. Demo migration (`apps/server` + `apps/client`)

Full end-to-end update (tilesets to be provided by the maintainer):

- **Server:** construct an `AssetManager`, register one raw image and one Tiled tileset, call
  `assets.mount(app)`, and create entities carrying `Image` (one plain image; one tileset
  frame). Demonstrate `sizeInMeters` by matching a physics body's size to its art.
- **Client:** add a `BootScene` (§7 option 1) that `await loadAssets(scene, ...)` with a
  progress bar, then `this.scene.start("Game", { catalog })`; the game scene connects and passes
  the catalog to `PhaserRenderModule`. No per-entity render code is added — `Image` entities
  render automatically alongside the existing shapes.

---

## 10. Testing strategy

- **`vecs-phaser`:** `Image` wire round-trip (texture/frame, defaults); `phaserNetworkComponents`
  order snapshot includes `Image` at 17; `phaserRenderableComponents` membership.
- **`vecs-phaser-server`:** raster dimension probing (png fixture); SVG requires an explicit
  size; spritesheet descriptor fields; **Tiled ingestion** (a `.tsj` fixture → frame dims,
  margin/spacing, columns/tileCount, and captured per-tile properties/animation/objectgroup);
  `id`/`key` stability and append-only ids; `sizeInMeters`; `toCatalog` strips server-only
  metadata; `mount` serves the catalog JSON and the asset files; single-image-only guard.
- **`vecs-phaser-client`:** `loadAssets` queues the correct loader calls per descriptor kind
  (mock Phaser loader), resolves on `complete`, and reports progress; the Image renderer
  creates on enter, applies `setTexture`/`setFrame` on change, sizes via `Size` vs native,
  destroys on exit — all with the existing mock Phaser objects.
- **Demo:** manual end-to-end per [`TICKETS.md`](./TICKETS.md) VPH-66.
- **Gates:** `npm run test|typecheck|lint|format` across workspaces.

---

## 11. Risks & mitigations

| Risk                                                      | Mitigation                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Adding `Image` reorders/extends the protocol              | Append-only at type 17; update the order snapshot test deliberately; document the bump in CHANGELOG |
| Catalog must exist before the first diff references an id | `await loadAssets(...)` before `connectDgram`; the load resolves only on loader `complete`          |
| SVG has no intrinsic pixel size                           | Author declares render size; used for both rasterization and the meter mapping                      |
| `vecs-phaser-server` gains heavier deps                   | Intentional and documented; keep probing/ingestion isolated so the ECS helpers stay importable      |
| Tiled image path is relative to the `.tsj`                | Resolve against the `.tsj` directory at ingest time; register the resolved file for serving         |
| `gif` loads only its first frame in Phaser                | Documented limitation; animation is out of scope for v1                                             |
| Author key vs wire id confusion                           | Key is server-only sugar; client keys textures by id; tests assert the key never crosses the wire   |

---

## 12. Success criteria

- Server registers raw images and Tiled tilesets by **human key**; each gets a stable numeric
  id; assets are served over HTTP from the server's existing Express app.
- Client fetches the catalog, loads everything, **then** starts the world; `Image` entities
  render automatically with no per-entity render code.
- "Both" sizing works: `Size` in meters wins; otherwise native pixels ÷ PPM.
- `sizeInMeters` lets server game code match a physics body to its art in one call.
- Tiled tile ids map 1:1 to frames; per-tile properties are readable server-side; animation and
  collision data are captured for later features.
- Nothing in v1 precludes dynamic assets or animated sprites.
  </content>
  </invoke>
