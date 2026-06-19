# vecs-phaser — Images & Asset Catalog (v1.0.36)

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

v1.0.36 ships **static images** (a Phaser `Image` GameObject) sourced from **Tiled tilesets** ingested
as spritesheets. The wire never carries paths or strings: "show frame `f` of resource `#id`"
is two numbers.

The design deliberately leaves the door open for later features without a protocol break:

- **Dynamic assets** — assets created at runtime while the world is already playing.
- **Animated sprites** — a separate `Sprite` renderable that reuses the same catalog.

### Non-goals (v1.0.36)

Full Tiled **maps** (`.tmj` tile-layer layout), **image-collection** tilesets (one image per
tile), **texture atlases** with named frames, **audio**, **animation playback**, **tinting**,
runtime/dynamic asset creation, and bundling assets into the client build. None of these are
precluded by the architecture; they are simply out of scope for the first version.

---

## 2. Verified facts (source of truth)

Confirmed by reading the code and the Tiled/Phaser references; implementers can rely on these.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Network type id = `phaserNetworkComponents` index + 1; **order is the protocol**                                                                                                                                                                                                                                                                                                                                                        | `lib/vecs-phaser/src/index.ts`, `lib/vecs-protocol/src/network_world.ts`                                                    |
| Renderable exclusivity is one component from `phaserRenderableComponents`                                                                                                                                                                                                                                                                                                                                                               | `lib/vecs-phaser/src/index.ts`, `PhaserServerModule`                                                                        |
| Wire scalars include `u16`/`u32`; ids already pack into `u32` (`cid_pack`)                                                                                                                                                                                                                                                                                                                                                              | `lib/vecs-wire/src/decorators.ts`, `lib/vecs-protocol/src/cid.ts`                                                           |
| The client adapter stores the live Phaser GameObject **as the entity's component** (`entity.attach(obj)`) and creates/updates/destroys it via `Implements` interface markers; PPM/Y-flip live only in `CoordSpace`                                                                                                                                                                                                                      | `lib/vecs-phaser-client/src/markers.ts`, `modules/*.ts`, `coord_space.ts`                                                   |
| Shared transform/style sync targets any GameObject through interface markers: `Position`/`Rotation`/`Scale` → `m.Transform`; `Alpha` → `m.Alpha`; `Depth` → `m.Depth`; `Size` → `m.Size`; `FillStyle` → `m.Fill`; `StrokeStyle` → `m.Stroke`                                                                                                                                                                                            | `lib/vecs-phaser-client/src/modules/sync.ts`                                                                                |
| The dgram transport is WebRTC datachannel with **HTTP signaling mounted on the app's Express instance**                                                                                                                                                                                                                                                                                                                                 | `node_modules/@vworlds/dgram-server/.../socket-listener.js`                                                                 |
| `connectDgram` performs an HTTP handshake against `worldPath(apiBasePath, worldName)` before the channel opens                                                                                                                                                                                                                                                                                                                          | `lib/vecs-client/src/client_world.ts:105`                                                                                   |
| The server already owns an Express `app` and CORS; the dgram listener mounts onto it                                                                                                                                                                                                                                                                                                                                                    | `apps/server/src/main.ts:130`, `lib/vecs-server/src/vecs_listener.ts`                                                       |
| Phaser: `scene.load.spritesheet(key, url, { frameWidth, frameHeight, margin, spacing })`; frames are row-major numeric                                                                                                                                                                                                                                                                                                                  | `/tmp/phaser/src/loader/filetypes/SpriteSheetFile.js`                                                                       |
| Phaser: `scene.add.image(x, y, key, frame)` / `image.setTexture(key, frame)` / `setDisplaySize(w, h)`                                                                                                                                                                                                                                                                                                                                   | `/tmp/phaser/src/gameobjects/image/ImageFactory.js`, `components/Texture.js`                                                |
| Tiled standalone tileset (`.tsj`): `image`, `imagewidth/height`, `tilewidth/height`, `margin`, `spacing`, `columns`, `tilecount`, sparse `tiles[]`                                                                                                                                                                                                                                                                                      | https://doc.mapeditor.org/en/stable/reference/json-map-format/                                                              |
| Tiled tile local id ordering is **row-major** → tile id == Phaser spritesheet frame index                                                                                                                                                                                                                                                                                                                                               | Tiled JSON reference; Phaser SpriteSheetFile                                                                                |
| `@kayahr/tiled` (MIT, pure-TS) is **the authoritative schema source** for this design — naming, field semantics, and discriminated unions follow it. It is **not** a runtime dependency: we copy the bare-minimum interfaces (only the fields we actually use) into a local `types/` subfolder and grow them field-by-field as features are added. The local interfaces stay as the type-check contract our concrete classes implement. | https://github.com/kayahr/tiled, `src/main/tileset/Tileset.ts`, `src/main/tile/Tile.ts`, `src/main/object/BaseMapObject.ts` |
| Tiled `Tile` fields: `id` (numeric local id), `type` (the "Class" field — `class` in Tiled ≥1.9, aliased), `properties` (`AnyProperty[]`, a typed array not a flat map), `objectgroup` (`ObjectGroup` of `MapObject` collision shapes), `animation` (`Frame[]`)                                                                                                                                                                         | kayahr/tiled `src/main/tile/Tile.ts`                                                                                        |
| Tiled `MapObject` carries `id` (unique across all objects in a tileset), `ellipse`/`polygon`/`polyline`/`point` shape flags, plus `width`/`height`/`rotation`/`x`/`y` (px), `name`, `properties`, `type` (Class). A circle is an ellipse with equal dims (Tiled has no dedicated circle)                                                                                                                                                | kayahr/tiled `src/main/object/BaseMapObject.ts`                                                                             |
| Tiled `Frame` (animation): `{ tileid: number, duration: number }` (ms)                                                                                                                                                                                                                                                                                                                                                                  | kayahr/tiled `src/main/tile/Frame.ts`                                                                                       |

---

## 3. Locked design decisions

1. **Catalog over HTTP, not the binary wire.** The server serves a per-world catalog JSON;
   the client fetches it and drives the Phaser loader. The datachannel stays state-only.
2. **Phaser-scoped resource layer.** Schema/contract in `vecs-phaser` (no `phaser` dep);
   catalog ownership, Tiled ingestion, dimension resolution, and HTTP serving in
   `vecs-phaser-server`; loader integration and rendering in `vecs-phaser-client`.
3. **Author key → typed handle → server-assigned numeric id.** Server code refers to assets by
   a human key (`"ship"`); `AssetManager.getTileset("ship")` returns a typed `TilesetAsset`
   handle carrying the stable numeric `id`. The wire carries only the number; the client
   registers Phaser textures keyed by the **id**, so the author key never reaches the client.
   Future asset types add their own `Asset` subclass and one `getX(key)` method each.
4. **Sizing is "Both."** `Size` (meters) present → `setDisplaySize` via PPM; absent → the
   texture's **native pixels ÷ PPM** (a 200×200 source at PPM 100 is a 2 m × 2 m object).
   Origin is `0.5` (center), matching every other renderable and Box2D body transforms.
5. **Server knows intrinsic pixel dimensions.** Because it owns the files, the catalog builder
   reads them at load time — spritesheet/tileset frame dimensions come straight from the Tiled
   file (`imagewidth/height`, `tilewidth/height`). A `TilesetAsset.sizeInMeters(ppm)` method
   makes "size this physics body to match the art" a one-liner. PPM stays off the wire (still
   meters everywhere).
6. **`Image` renderable, backed by a Phaser `Image`.** Component `Image { texture, frame }`,
   appended to the protocol as **type 17**. No tint, no animation in v1.0.36. Animation later lands
   on a _separate_ `Sprite` renderable, not this one.
7. **Load-then-start.** `await loadAssets(...)` resolves only when every asset is loaded, so no
   diff can reference an unloaded texture. Enforced by ordering, not by per-frame guards.
8. **Append-only id space.** Ids are server-assigned and never reused or reordered, so a future
   in-band "asset added" message can extend the catalog at runtime without disturbing v1.0.36.

---

## 4. Catalog model

The catalog is the shared contract between server and client. It travels as **JSON over
HTTP** (so its types carry no `@wireType`), and it lives in `vecs-phaser` so both ends agree.

v1.0.36 has a single asset kind — **spritesheet** — because every asset is a Tiled tileset. The
schema is split by extension: a base `AssetDescriptor` carries the identity triple (`id`,
`key`, `kind`), and each per-kind interface `extends` it, narrows `kind` to its literal, and adds
its own load fields (including `url`, since a future kind may need more than one url). New
kinds append a new `*Descriptor extends AssetDescriptor` — the base never changes.

```ts
// @vworlds/vecs-phaser  (data-only, no phaser dep)
export interface AssetDescriptor {
  id: number; // wire id (stable, append-only)
  key: string; // author key, authoring/debug only
  kind: string; // discriminant; narrowed by each subclass to its literal
}

export interface SpritesheetDescriptor extends AssetDescriptor {
  kind: "spritesheet";
  url: string; // HTTP url the client loads the source image from
  frameWidth: number; // tile width (px)
  frameHeight: number; // tile height (px)
  margin: number; // tileset margin (px)
  spacing: number; // tile spacing (px)
  columns: number; // tiles per row
  tileCount: number; // total frames
  imageWidth: number; // source image width (px)
  imageHeight: number; // source image height (px)
}

export interface AssetCatalog {
  worldName: string;
  assets: AssetDescriptor[]; // heterogeneous; the client narrows per element via `kind`
}
```

**Per-tile Tiled metadata (properties, animations, collision shapes) is intentionally
excluded** from the catalog DTO — it is server-only game-logic data; the client only ever
needs `(id, frame)` to render.

---

## 5. Component specification

`vecs-phaser` gains one networked component and reuses the existing `Size`.

```ts
/** Textured renderable. Both fields index the asset catalog. */
export class Image {
  /** Resource id of the source texture (image or spritesheet). */
  @wireType("u32")
  public texture = 0;

  /** Frame index within a spritesheet/tileset. */
  @wireType("u16")
  public frame = 0;
}
```

- Appended to `phaserNetworkComponents` as **type 17** (deliberate protocol bump; the order
  snapshot test must be updated in the same change) and added to `phaserRenderableComponents`
  so exclusivity treats it as one-of the renderables.
- **Sizing:** if the entity also carries `Size` (meters), the `Image` renderer calls
  `setDisplaySize(coords.len(width), coords.len(height))`; otherwise it leaves Phaser's native
  frame size and the on-screen meters fall out of `nativePx ÷ PPM`. Sizing lives in the `Image`
  renderer (§6.3) rather than the shared `Size` sync because Phaser images size via
  `setDisplaySize`, whereas the shared sync drives shapes through `setSize` (the `m.Size` marker);
  `Image` therefore does **not** declare `Implements` for `m.Size`.
- **Transform/style reuse:** the `Image` GameObject declares `Implements` for `GameObject`,
  `Transform`, `Alpha`, and `Depth`, so the existing shared sync systems drive
  `Position`/`Rotation`/`Scale`/`Alpha`/`Depth` unchanged. It does **not** implement `Fill`/`Stroke`,
  so `FillStyle`/`StrokeStyle` never target `Image`.

---

## 6. Package architecture

```
@vworlds/vecs-phaser            Image component + AssetDescriptor/AssetCatalog types
        │  (data-only, no phaser dep)
        ▼
@vworlds/vecs-phaser-server     AssetManager → Asset/TilesetAsset/Tile handles; Tiled ingestion; serve
        │  deps add: express (peer)  — NO @kayahr/tiled runtime dep; minimal Tiled
        │  schema interfaces are vendored into src/types/ (grown field-by-field)
        ▼
@vworlds/vecs-phaser-client     loadAssets(scene, conn) + Image renderer (peer: phaser)
```

> **Note (intentional):** this expands `vecs-phaser-server` beyond its current "thin pure-ECS,
> no deps" character. Adding Tiled ingestion and HTTP serving is the point — the server owns
> the asset catalog.

### 6.1 Server — `AssetManager`, `Asset`, `TilesetAsset`, `Tile`

The server-side asset layer is a **loader + cache of typed asset handles**. v1.0.36 has one asset
type, **tileset**; future types (audio, etc.) add their own `Asset` subclass and one
`getX(key)` method each.

The Tiled JSON schema is **vendored, not depended on**: `src/types/` holds the bare-minimum
Tiled interfaces (copied from `@kayahr/tiled` as the authoritative source) — only the fields v1.0.36
actually uses, grown field-by-field as features are added. Our concrete classes (`TilesetAsset`,
`Tile`, `MapObject`, …) `implements` those interfaces, so the interfaces act as the type-check
contract for the concrete classes. Parsing builds concrete instances via a **`JSON.parse`
reviver** rather than populating plain objects, so `getTileset(key)` returns live `TilesetAsset`
/ `Tile` instances with their methods, not raw data bags.

**Our interfaces drop Tiled's optionality.** `@kayahr/tiled` marks sparse fields `?` (e.g.
`properties?`, `tiles?`, `objectgroup?`, `class?`) because Tiled omits them when empty. Our
vendored copies **remove the `?`** and our concrete classes **guarantee non-null, empty-by-
default collections** — `properties: AnyProperty[]` (never `undefined`, `[]` when absent),
`objects: Map<...>` (`[]`/empty `Map` when absent), `class: string` (`""` when absent), etc.
The reviver supplies these defaults at parse time, so consumers never null-check and the classes
stay nice to use.

```
src/
  types/                          // vendored Tiled schema (minimal, grown as needed)
    Tileset.ts                    // Tileset, Tile, MapObject, Frame, AnyProperty…
  asset.ts                        // Asset base class (implements nothing from types/ by itself)
  tileset_asset.ts               // TilesetAsset extends Asset, implements Tileset-ish fields
  tile.ts                         // Tile implements the vendored Tile interface
  asset_manager.ts                // loader + WeakMap cache + toCatalog + mount

AssetManager                          // loader + map<key, Asset> + WeakMap cache
  constructor({ assetsPath })         // e.g. "assets"
  getTileset(key): TilesetAsset       // assetsPath/tilesets/<key>.tsj (.json fallback)
        └─ WeakMap<key, Asset>        // lazily parsed; cached while a handle is held
  toCatalog(worldName): AssetCatalog // enumerates all cached assets → wire DTO
  mount(app)                          // GET {worldPath}/assets (catalog) + static assetsPath

Asset  (base class)
  id: number                          // stable, append-only wire id (server-assigned)
  key: string                         // human key; authoring/debug only

TilesetAsset extends Asset
  image: string                       // resolved image url (relative to the .tsj)
  frameWidth, frameHeight             // tilewidth, tileheight
  margin, spacing, columns, tileCount // straight from the Tiled file
  imageWidth, imageHeight
  class: string                       // Tiled tileset "Class" (was `type` pre-1.9)
  properties: AnyProperty[]           // Tiled typed property array (vendored type)
  sizeInMeters(ppm): { w, h }         // { tilewidth/ppm, tileheight/ppm }
  tile(id): Tile | undefined          // per-tile lookup by numeric tile id

Tile
  id: number                          // numeric tile id (== Phaser frame index)
  class: string                       // Tiled tile "Class"
  properties: AnyProperty[]          // Tiled typed property array (vendored type)
  objects: Map<MapObject.id, MapObject>  // collision/anchor shapes
  animation: Frame[]                  // captured for the future Sprite feature
```

**Authoring contract:**

```ts
const assets = new AssetManager({ assetsPath: "assets" });

const terrain = assets.getTileset("terrain"); // parses assets/tilesets/terrain.tsj
const ship = assets.getTileset("ship"); // parses assets/tilesets/ship.tsj

ship.id; // → number for the Image component / wire
ship.sizeInMeters(PPM); // → { w: 2, h: 2 }   (physics-body matching)
terrain.tile(5)?.properties; // → AnyProperty[]      (server-only)
terrain.tile(5)?.objects; // → Map<id, MapObject> (collision shapes)

assets.toCatalog(world.name); // → AssetCatalog DTO (server-only metadata stripped)
assets.mount(app); // GET {worldPath}/assets (catalog) + static files
```

- **Path convention:** `assetsPath/tilesets/<key>.tsj`; if `.tsj` is missing, try `<key>.json`.
  The human key doubles as the filename stem.
- **Lazy load + cache:** `getTileset(key)` parses the `.tsj`/`.json` on first call and caches
  the `TilesetAsset` in a `WeakMap` keyed by the human key; a cached handle is reused while any
  code holds it, and eligible for GC once released. The image **bytes** are never loaded
  server-side — only metadata; bytes are served over HTTP to the client by `mount` (§6.3).
- **Type-checked getters:** `getTileset(key)` verifies the cached/loaded `Asset` is a
  `TilesetAsset` (not, e.g., a future `AudioAsset`) and throws a typed error on mismatch.
- **Id assignment:** ids are server-assigned, stable, and append-only — allocated the first
  time an asset is loaded, never reused or reordered.
- **Serving:** `mount` registers (a) the catalog JSON route and (b) a static file route over
  the whole `assetsPath` (the client loads any image the catalog references), on the same
  Express `app` the server already owns, under the existing per-world
  `worldPath(apiBasePath, worldName)`. CORS is already configured at the app level.
- **Usage in game code:**
  ```ts
  const ship = assets.getTileset("ship");
  world.entity().add(Networked).set(Image, { texture: ship.id, frame: 0 });
  ```

### 6.2 Server — Tiled tileset ingestion

Loading a `TilesetAsset` from `assetsPath/tilesets/<key>.tsj` (or `.json`):

1. Read the file and `JSON.parse(text, reviver)` — the **reviver** constructs the concrete
   `TilesetAsset`/`Tile`/`MapObject` instances (typed against the vendored `src/types/`
   interfaces) instead of returning plain objects, so the returned tree already carries its
   methods. Only the v1.0.36-needed fields are read; others are ignored (the `types/` interfaces grow
   as we add features).
2. Resolve the tileset's `image` path **relative to the `.tsj` location** (the resolved path is
   what `mount` serves and what the catalog's `url` points at).
3. Build the spritesheet fields (`frameWidth = tilewidth`, `frameHeight = tileheight`,
   `margin`, `spacing`, `columns`, `tileCount`, `imageWidth`, `imageHeight`) for the catalog
   DTO; keep them on the `TilesetAsset` for `sizeInMeters`.
4. Build the sparse `Tile` map keyed by **numeric tile id** from the Tiled `tiles[]` array,
   supplying **non-null defaults** for every omitted Tiled field (no `?` on our interfaces):
   - `id` (numeric, == Phaser frame index),
   - `class` (Tiled `type`/`class` field, `""` when absent),
   - `properties` — the Tiled **typed** `AnyProperty[]` (vendored type; preserved as-is, not
     flattened, so declared property types like color/file/int survive; `[]` when absent),
   - `objects` — the `objectgroup`'s `MapObject[]` re-indexed into a `Map` keyed by
     `MapObject.id` (Tiled's unique-per-tileset object id),
   - `animation` — the `Frame[]` (`{ tileid, duration }`), captured for the future `Sprite`.
5. Allocate the stable wire `id` (append-only).

Because Tiled tile ids and Phaser spritesheet frame indices are both row-major,
**tile id == frame**, so `set(Image, { texture: ship.id, frame: tileId })` shows that exact
tile, and `terrain.tile(tileId)` returns its metadata.

Scope guards for v1.0.36: **single-image** tilesets only (reject image-collection tilesets, where
tiles carry their own `image`); **tilesets only** (no `.tmj` map parsing).

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
  `scene.load.spritesheet(String(id), url, { frameWidth, frameHeight, margin, spacing })`,
  calls `scene.load.start()`, and resolves a `Catalog` (an `id → descriptor` lookup) on the
  loader `complete` event. It surfaces the loader's progress for a loading bar.
- The **Phaser texture key is the resource id** (`String(id)`), so the renderer maps
  `Image.texture` → key with no author-key knowledge.
- New `src/modules/image.ts` mirrors the shape renderers' attach + interface-marker lifecycle
  (§7 of `README.md`):
  - **Init wiring:** add a `Texture` interface marker to `markers.ts` (abstract `setTexture` /
    `setDisplaySize`, alongside `m.Arc`, `m.Star`, …); register
    `world.component(Phaser.GameObjects.Image).set(Implements, { interfaces: [m.GameObject,
m.Transform, m.Alpha, m.Depth, m.Texture] })`; and add the shape-data remove hook
    `world.component(Image).onRemove(e => e.remove(Phaser.GameObjects.Image))` (which triggers the
    shared `GameObject.onRemove → destroy`).
  - `phaser.new.image`: `.with(Image).without(Phaser.GameObjects.Image).phase(ON_STORE)`; on
    `.enter`, `entity.attach(scene.add.image(0, 0, String(texture), frame).setOrigin(0.5))`.
  - `phaser.render.image.texture`: `.with(Image, m.Texture).phase(ON_STORE)`; on
    `update({ watch: Image, inject: [m.Texture] })`, call `setTexture(String(texture), frame)`.
  - `phaser.render.image.size`: `.with(Image, m.Texture).phase(ON_STORE)`; on
    `update({ watch: Size, onEnter: true, inject: [m.Texture] })`, apply `setDisplaySize` from
    `Size`, or leave native when `Size` is absent.
  - **No per-renderer `.exit`:** teardown flows through the shape-data remove hook → the shared
    `GameObject.onRemove → destroy`, exactly like the shape renderers.
- The render module accepts the resolved `catalog` so it can validate ids and (later) resolve
  descriptor metadata; rendering itself needs only the texture key + frame.

---

## 7. Load-then-start ordering

`loadAssets` is awaited **before** `connectDgram`, guaranteeing every texture is resident
before the first state diff arrives. The **default app structure is a dedicated boot/loading
scene** (idiomatic Phaser), which also gives a natural home for the load progress UI:

1. **Dedicated boot/loading scene (v1.0.36 default).** A lightweight `BootScene` does
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
  Phaser load before the referencing entity renders. v1.0.36 builds none of this but precludes none.
- **Animated sprites:** a future `Sprite` renderable (its own `phaserNetworkComponents` entry)
  reuses the same catalog and the captured Tiled `animation` frames. `Image` stays the static
  path.
- **Physics-matched collision:** captured Tiled `objectgroup` shapes can later build
  vecs-physics bodies that match the art; `sizeInMeters` covers the simple rectangular case now.

---

## 9. Demo migration (`apps/server` + `apps/client`)

Full end-to-end update (tilesets to be provided by the maintainer):

- **Server:** construct an `AssetManager({ assetsPath: "assets" })`, load two tilesets via
  `assets.getTileset("terrain")` and `assets.getTileset("ship")`, call `assets.mount(app)`, and
  create entities carrying `Image` — one per tileset, each at a chosen frame. Demonstrate
  `ship.sizeInMeters(PPM)` by matching a physics body's size to its art.
- **Client:** add a `BootScene` (§7 option 1) that `await loadAssets(scene, ...)` with a
  progress bar, then `this.scene.start("Game", { catalog })`; the game scene connects and passes
  the catalog to `PhaserRenderModule`. No per-entity render code is added — `Image` entities
  render automatically alongside the existing shapes.

---

## 10. Testing strategy

- **`vecs-phaser`:** `Image` wire round-trip (texture/frame, defaults); `phaserNetworkComponents`
  order snapshot includes `Image` at 17; `phaserRenderableComponents` membership.
- **`vecs-phaser-server`:** `AssetManager` loads a `.tsj` fixture from
  `assetsPath/tilesets/<key>` (and falls back to `.json` when `.tsj` is missing); returns a
  `TilesetAsset` whose spritesheet fields (frame dims, margin/spacing, columns/tileCount, image
  dims, resolved image url) match the fixture; `tile(id)` returns a `Tile` with the captured
  `class`, **typed** `properties` (`AnyProperty[]`, preserved — not flattened), `objects`
  (`Map` keyed by `MapObject.id`, with `ellipse`/`polygon`/`polyline` shape flags + width/
  height/rotation/x/y), and `animation` for tiles that define them, and `undefined` for tiles
  that don't; **a tile/tileset whose Tiled source omits `properties`/`objects`/`class`/
  `animation` exposes non-null empty defaults (`[]`, empty `Map`, `""`) — never `undefined`**;
  `getTileset(key)` is cached (second call returns the same handle) and type-checks (a future
  non-tileset asset under the same key throws); ids are stable and append-only across calls;
  `sizeInMeters(ppm)` returns `tileWidth ÷ ppm`; `toCatalog` strips server-only metadata;
  `mount` serves the catalog JSON and static files under `assetsPath`; single-image-only guard
  (reject image-collection tilesets).
- **`vecs-phaser-client`:** `loadAssets` queues `load.spritesheet` for every descriptor (mock
  Phaser loader), resolves on `complete`, and reports progress; the Image renderer attaches on
  `phaser.new.image` enter, applies `setTexture`/`setFrame` via the `Texture` marker, sizes via
  the `phaser.render.image.size` system (`Size` → `setDisplaySize` vs native), and tears down
  through the shape-data remove hook → shared `GameObject.onRemove → destroy` (no per-renderer
  `.exit`) — all with the existing mock Phaser objects.
- **Demo:** manual end-to-end per [`TICKETS.md`](./TICKETS.md) VPH-65.
- **Gates:** `npm run test|typecheck|lint|format` across workspaces.

---

## 11. Risks & mitigations

| Risk                                                      | Mitigation                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Adding `Image` reorders/extends the protocol              | Append-only at type 17; update the order snapshot test deliberately; document the bump in CHANGELOG  |
| Catalog must exist before the first diff references an id | `await loadAssets(...)` before `connectDgram`; the load resolves only on loader `complete`           |
| `vecs-phaser-server` gains heavier deps                   | Intentional and documented; keep Tiled ingestion/serving isolated so the ECS helpers stay importable |
| Tiled image path is relative to the `.tsj`                | Resolve against the `.tsj` directory at load time; serve the resolved path under `assetsPath`        |
| `WeakMap` cache drops a handle mid-use                    | Handles are held by game code for the entity's lifetime; cache only speeds re-`getTileset` calls     |
| Author key vs wire id confusion                           | Key is server-only sugar; client keys textures by id; tests assert the key never crosses the wire    |

---

## 12. Success criteria

- Server loads Tiled tilesets by **human key** into typed `TilesetAsset` handles; each handle
  carries a stable numeric id; assets are served over HTTP from the server's existing Express
  app.
- Client fetches the catalog, loads everything, **then** starts the world; `Image` entities
  render automatically with no per-entity render code.
- "Both" sizing works: `Size` in meters wins; otherwise native pixels ÷ PPM.
- `TilesetAsset.sizeInMeters` lets server game code match a physics body to its art in one call.
- Tiled tile ids map 1:1 to frames; per-tile `class`/`properties`/`objects` are readable
  server-side; `animation` is captured for the future `Sprite` feature.
- Nothing in v1.0.36 precludes dynamic assets or animated sprites.
  </content>
  </invoke>
