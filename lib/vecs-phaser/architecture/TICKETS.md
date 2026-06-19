# vecs-phaser — Ticket Breakdown: Images & Asset Catalog (v1.0.36)

Delegate-ready tickets for the design in [`ASSETS.md`](./ASSETS.md). Each ticket is sized for
one subagent and states scope, files, dependencies, and acceptance criteria. **Read
`ASSETS.md` first** — it is the contract; tickets do not repeat the catalog schema, component
spec, or sizing rules.

> The original primitive-shape render layer (VPH-1…VPH-50) shipped; its breakdown lives in git
> history. This file now tracks the Images & Asset Catalog feature, numbered **VPH-60+** to
> avoid collision with those shipped ids.

## Conventions for every ticket

- Match repo rules in `.agent/rules/` (commits, formatting, testing). Test-first where practical.
- **Implementation tickets:** read the [vecs Design Guide](../../vecs/docs/design-guide.md) before
  writing components/systems/modules — follow its idioms (resource-as-component lifecycle, reactive
  sync over scanning, one-system-one-phase) and avoid its anti-patterns. Skip for pure
  formatting/docs/release tickets.
- Mirror an existing `lib/vecs-*` package for package.json / tsconfig / vitest shape.
- TypeScript strict; ESM; no `any` leaks across public API.
- A ticket is **Done** only when `npm run typecheck`, `lint`, and its `test` pass for its package.

## Dependency graph (waves)

```
W0 vecs-phaser (data) ─┬─▶ W1 vecs-phaser-server ─┐
   VPH-60, VPH-61      │      VPH-62              ├─▶ W3 demo ─▶ W4 docs
                        └─▶ W2 vecs-phaser-client ──┘   VPH-65    VPH-66
                               VPH-63, VPH-64
```

Parallelizable: VPH-62 (server) runs in parallel with VPH-63/64 (client) once W0 lands.

---

## Wave 0 — `@vworlds/vecs-phaser` (data-only)

### VPH-60 — `Image` component + protocol order

**Deps:** none · **Files:** `src/components/image.ts`, `src/index.ts`, `tests/image.test.ts`, `tests/protocol.test.ts`

Add `Image { @u32 texture; @u16 frame }` per ASSETS.md §5. Append it to
`phaserNetworkComponents` as **type 17** and to `phaserRenderableComponents`. Update the
component-order JSDoc/table.

**Acceptance:** `Image` wire round-trip (texture, frame, defaults survive encode→decode); the
`phaserNetworkComponents` order snapshot is updated and pins `Image` at index 16 (type 17);
`phaserRenderableComponents` includes `Image`.

### VPH-61 — Catalog schema types

**Deps:** none (parallel with VPH-60) · **Files:** `src/catalog.ts`, `src/index.ts`, `tests/catalog.test.ts`

Define the catalog schema per ASSETS.md §4 as plain TS types (no `@wireType`): a base
`AssetDescriptor` (`{ id, key, kind: string }`) and `SpritesheetDescriptor extends
AssetDescriptor` narrowing `kind: "spritesheet"` and adding the load fields (`url`,
`frameWidth/Height`, `margin`, `spacing`, `columns`, `tileCount`, `imageWidth/Height`). Plus
`AssetCatalog { worldName, assets: AssetDescriptor[] }`. Export all from the barrel. The base
is open to future `*Descriptor extends AssetDescriptor` members without change.

**Acceptance:** a `SpritesheetDescriptor` typechecks with all required fields and its `kind`
narrows to `"spritesheet"`; an `AssetCatalog` with a spritesheet element typechecks against the
heterogeneous `AssetDescriptor[]` (narrowed per element via `kind`); a `satisfies` assertion
confirms `kind` is the only discriminant; no `phaser`/`@wireType` imports leak in.

---

## Wave 1 — `@vworlds/vecs-phaser-server` (`AssetManager`)

### VPH-62 — AssetManager, Asset/TilesetAsset/Tile, serve

**Deps:** VPH-61 · **Files:** `src/asset_manager.ts`, `src/asset.ts`,
`src/tileset_asset.ts`, `src/tile.ts`, `src/types/` (vendored Tiled schema), `src/index.ts`,
`tests/asset_manager.test.ts`, `tests/tileset_asset.test.ts`, `tests/fixtures/tilesets/*`

Implement the typed-handle asset layer per ASSETS.md §6.1–§6.2:

- `src/types/` — vendor the **bare-minimum** Tiled schema interfaces from `@kayahr/tiled` (the
  authoritative source) — only the fields v1.0.36 uses. Start with `Tileset`, `Tile`, `MapObject`,
  `Frame`, `AnyProperty` (and its needed variants). **Drop the `?`** that `@kayahr/tiled` puts on
  sparse fields (`properties?`, `tiles?`, `objectgroup?`, `class?`, …): our interfaces declare
  them required, and our concrete classes supply non-null empty defaults (`[]`, empty `Map`, `""`)
  so consumers never null-check. No `@kayahr/tiled` runtime dependency; these interfaces are the
  type-check contract the concrete classes `implements`.
- `AssetManager({ assetsPath })` — loader + `WeakMap<key, Asset>` cache.
- `getTileset(key): TilesetAsset` — derive `assetsPath/tilesets/<key>.tsj` (fall back to
  `<key>.json` if `.tsj` missing); `JSON.parse(text, reviver)` where the **reviver** constructs
  the concrete `TilesetAsset`/`Tile`/`MapObject` instances (typed against `src/types/`) rather
  than returning plain objects; resolve the tileset `image` relative to the file; cache the
  `TilesetAsset`; return the same handle on repeat calls; verify the cached `Asset` is a
  `TilesetAsset` (throw a typed error if a future non-tileset asset lives under that key).
- `Asset` base — `{ id: number; key: string }`; ids are server-assigned, stable, append-only.
- `TilesetAsset extends Asset` — `image`, `frameWidth/Height`, `margin`, `spacing`, `columns`,
  `tileCount`, `imageWidth/Height`, `class`, `properties: AnyProperty[]`, `tile(id): Tile |
undefined`, `sizeInMeters(ppm): { w, h }`.
- `Tile` — `{ id: number; class: string; properties: AnyProperty[]; objects:
Map<MapObject.id, MapObject>; animation: Frame[] }`. Objects keep Tiled shape flags
  (`ellipse`/`polygon`/`polyline`/`point`) + `width`/`height`/`rotation`/`x`/`y`/`name`/`type`.
- `toCatalog(worldName): AssetCatalog` and `mount(app)` — catalog JSON route + static file route
  over `assetsPath`, under `worldPath(apiBasePath, worldName)`. Reject image-collection tilesets.

**Acceptance:** `getTileset("terrain")` from a `.tsj` fixture returns a live `TilesetAsset`
instance (with its methods, not a plain object) whose spritesheet fields and resolved image url
match the fixture; a `.json`-only fixture also loads (when no `.tsj` exists); a second
`getTileset("terrain")` returns the same handle; `tile(id)` returns a `Tile` with the captured
`class`, **typed** `properties` (`AnyProperty[]`, preserved not flattened), `objects` (`Map`
keyed by `MapObject.id` with shape flags + dims), and `animation` for tiles that define them, and
`undefined` for tiles that don't; **a tile (or tileset) whose Tiled source omits `properties`/
`objects`/`class`/`animation` exposes non-null empty defaults (`[]`, empty `Map`, `""`) — never
`undefined` — so no consumer null-check is needed**; `sizeInMeters(ppm)` returns `tileWidth ÷
ppm`; ids are stable and append-only; `toCatalog` strips server-only metadata; `mount` serves
the catalog JSON and the static `assetsPath` files (assert via a supertest/extract against a
mock or real Express app); an image-collection tileset is rejected with a clear error;
`package.json` has **no**
`@kayahr/tiled` dependency.

---

## Wave 2 — `@vworlds/vecs-phaser-client`

### VPH-63 — `loadAssets` helper + `Catalog`

**Deps:** VPH-61 · **Files:** `src/load_assets.ts`, `src/index.ts`, `tests/load_assets.test.ts`

Implement `loadAssets(scene, conn)` per ASSETS.md §6.3: fetch `{worldPath}/assets`, queue
`scene.load.spritesheet(String(id), url, { frameWidth, frameHeight, margin, spacing })` for
every descriptor (all v1.0.36 assets are spritesheets), `start()`, resolve a `Catalog`
(`id → descriptor`) on loader `complete`, and surface progress. Keep `phaser` a type-only peer.

**Acceptance:** with a mock loader + stubbed fetch, every descriptor queues `load.spritesheet`
with `{frameWidth,frameHeight,margin,spacing}`; the promise resolves only after `complete`;
progress is reported; the resolved `Catalog` looks ids up to descriptors.

### VPH-64 — Image renderer + sizing

**Deps:** VPH-60, VPH-63 (and the existing render module) · **Files:** `src/modules/image.ts`, `src/modules/phaser_render.ts`, `tests/image_renderer.test.ts`

Add the `Image` renderer mirroring the shape renderers (ASSETS.md §6.3): create
`scene.add.image(0,0,String(texture),frame)` + `setOrigin(0.5)` on enter; on update apply
`setTexture(String(texture), frame)` and size via `Size` (→ `setDisplaySize(len(w),len(h))`) or
native; destroy on exit. Accept the resolved `catalog` in `PhaserRenderModuleConfig`. Reuse the
existing transform/style sync for Position/Rotation/Scale/Alpha/Depth.

**Acceptance:** entering an `Image` entity creates an image with the id-keyed texture + frame
and origin 0.5; changing `texture`/`frame` calls `setTexture`/`setFrame`; with `Size` present
`setDisplaySize` uses CoordSpace `len`, without it the native size is left; exit destroys; a
moving `Image` tracks `Position` through the shared sync. Mock Phaser objects.

---

## Wave 3 — Demo

### VPH-65 — Demo: register, serve, render, match a body

**Deps:** W1, W2 · **Files:** `apps/server/src/main.ts`, `apps/server/package.json`, `apps/client/src/main.ts`, `apps/client/package.json`, demo assets

Per ASSETS.md §9: server builds an `AssetManager`, registers two Tiled tilesets (placeholder
until maintainer provides art), `mount(app)`, and creates `Image` entities (one per tileset, at
a chosen frame), sizing one physics body via `sizeInMeters`. Client adds a `BootScene`
(ASSETS.md §7 option 1) that `await loadAssets(...)` with a progress bar, then
`this.scene.start("Game", { catalog })`; the game scene connects and passes the catalog to
`PhaserRenderModule`. No per-entity render code added.

**Acceptance:** `npm run dev` (server + client) shows a loading scene that completes before the
world connects, then the tileset frames rendered alongside the existing shapes; the
body-matched entity's collision matches its art size.

---

## Wave 4 — Docs & release hygiene

### VPH-66 — Docs, CHANGELOG, ROADMAP

**Deps:** all · **Files:** package `README.md`s, `architecture/CHANGELOG.md`, `architecture/ROADMAP.md`, JSDoc

Update `vecs-phaser*` READMEs for the new component/helpers; add a CHANGELOG entry noting the
**protocol bump (type 17 `Image`)**; in ROADMAP, reconcile the "Sprite renderables" line (v1.0.36
ships static `Image` sourced from Tiled tilesets; animated `Sprite` remains future). Ensure
JSDoc on every new public symbol per `.agent/rules/documentation.md`.

**Acceptance:** docs build/links resolve; `npm run format:check` clean; CHANGELOG and ROADMAP
reflect what shipped vs. what remains.

---

## Future work (not in this wave)

Deferred from v1.0.36 per ASSETS.md §8 — no protocol break when they land:

- **Dynamic assets** — in-band "asset added" message extends the catalog at runtime.
- **Animated `Sprite` renderable** — reuses the catalog + captured Tiled `animation` frames.
- **Physics-matched collision** — build vecs-physics bodies from captured Tiled `objectgroup`
  shapes.

---

## Suggested delegation order

1. Parallel: **VPH-60**, **VPH-61**.
2. Parallel: **VPH-62** (server) alongside **VPH-63 → VPH-64** (client).
3. **VPH-65** (demo).
4. **VPH-66** (docs).
   </content>
