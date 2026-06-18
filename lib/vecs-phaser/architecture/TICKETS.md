# vecs-phaser — Ticket Breakdown: Images & Asset Catalog (v1)

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
   VPH-60, VPH-61      │      VPH-62, VPH-63       ├─▶ W3 demo ─▶ W4 docs
                       └─▶ W2 vecs-phaser-client ──┘   VPH-66      VPH-67
                              VPH-64, VPH-65
```

Parallelizable: VPH-62/63 (server) run in parallel with VPH-64/65 (client) once W0 lands.

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

Define `AssetDescriptor` (tagged union: `image` | `spritesheet`) and `AssetCatalog` per
ASSETS.md §4 as plain TS types (no `@wireType`). Export from the barrel.

**Acceptance:** a descriptor of each kind typechecks with its required fields; a type-level test
(or `satisfies`) asserts the union discriminant; no `phaser`/`@wireType` imports leak in.

---

## Wave 1 — `@vworlds/vecs-phaser-server` (`AssetManager`)

### VPH-62 — AssetManager: register, probe, size, serve

**Deps:** VPH-61 · **Files:** `src/asset_manager.ts`, `src/index.ts`, `tests/asset_manager.test.ts`, `tests/fixtures/*`

Implement `AssetManager` per ASSETS.md §6.1 for raw images and explicit spritesheets:
`image(key, path, opts?)`, `spritesheet(key, path, frameConfig)`, `id(key)`, `key(id)`,
`sizeInMeters(key, ppm)`, `toCatalog(worldName)`, `mount(app)`. Probe raster dimensions via
`image-size` (add the dep); require an explicit size for `.svg`. Assign stable, append-only
numeric ids. Mount catalog + static file routes under `worldPath(apiBasePath, worldName)`.

**Acceptance:** registering a png fixture probes its real dimensions; an `.svg` without a size
throws; ids are stable across calls and never reused; `sizeInMeters` returns `px ÷ ppm`;
`toCatalog` emits correct descriptors; `mount` serves the catalog JSON and the bytes of each
asset (assert via a supertest/extract against a mock or real Express app).

### VPH-63 — Tiled tileset ingestion

**Deps:** VPH-62, `@kayahr/tiled` · **Files:** `src/tiled.ts`, `tests/tiled.test.ts`, `tests/fixtures/*.tsj`

Implement `tileset(key, tsjPath)` per ASSETS.md §6.2 using `@kayahr/tiled` types. Resolve the
`image` path relative to the `.tsj`; emit a `spritesheet` descriptor (frame dims = tile dims,
margin/spacing/columns/tileCount/image dims); store per-tile metadata server-side keyed by tile
id; expose `tile(key, tileId)`. Reject image-collection tilesets (single-image only).

**Acceptance:** a `.tsj` fixture yields the correct spritesheet descriptor and resolved image
url; `tile(key, id)` returns captured `properties`, `animation`, and `objectgroup` for tiles
that define them and `undefined`/empty for tiles that don't; `toCatalog` omits the per-tile
metadata; an image-collection tileset is rejected with a clear error.

---

## Wave 2 — `@vworlds/vecs-phaser-client`

### VPH-64 — `loadAssets` helper + `Catalog`

**Deps:** VPH-61 · **Files:** `src/load_assets.ts`, `src/index.ts`, `tests/load_assets.test.ts`

Implement `loadAssets(scene, conn)` per ASSETS.md §6.3: fetch `{worldPath}/assets`, queue the
right loader call per descriptor kind keyed by `String(id)`, `start()`, resolve a `Catalog`
(`id → descriptor`) on loader `complete`, and surface progress. Keep `phaser` a type-only peer.

**Acceptance:** with a mock loader + stubbed fetch, image descriptors queue `load.image` and
spritesheet descriptors queue `load.spritesheet` with `{frameWidth,frameHeight,margin,spacing}`;
the promise resolves only after `complete`; progress is reported; the resolved `Catalog` looks
ids up to descriptors.

### VPH-65 — Image renderer + sizing

**Deps:** VPH-60, VPH-64 (and the existing render module) · **Files:** `src/modules/image.ts`, `src/modules/phaser_render.ts`, `tests/image_renderer.test.ts`

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

### VPH-66 — Demo: register, serve, render, match a body

**Deps:** W1, W2 · **Files:** `apps/server/src/main.ts`, `apps/server/package.json`, `apps/client/src/main.ts`, `apps/client/package.json`, demo assets

Per ASSETS.md §9: server builds an `AssetManager`, registers one raw image and one Tiled
tileset (placeholder until maintainer provides art), `mount(app)`, and creates `Image`
entities (one plain image; one tileset frame), sizing one physics body via `sizeInMeters`.
Client adds a `BootScene` (ASSETS.md §7 option 1) that `await loadAssets(...)` with a progress
bar, then `this.scene.start("Game", { catalog })`; the game scene connects and passes the
catalog to `PhaserRenderModule`. No per-entity render code added.

**Acceptance:** `npm run dev` (server + client) shows a loading scene that completes before the
world connects, then the image and the tileset frame rendered alongside the existing shapes; the
body-matched entity's collision matches its art size.

---

## Wave 4 — Docs & release hygiene

### VPH-67 — Docs, CHANGELOG, ROADMAP

**Deps:** all · **Files:** package `README.md`s, `architecture/CHANGELOG.md`, `architecture/ROADMAP.md`, JSDoc

Update `vecs-phaser*` READMEs for the new component/helpers; add a CHANGELOG entry noting the
**protocol bump (type 17 `Image`)**; in ROADMAP, reconcile the "Sprite renderables" line (v1
ships static `Image`; animated `Sprite` remains future). Ensure JSDoc on every new public
symbol per `.agent/rules/documentation.md`.

**Acceptance:** docs build/links resolve; `npm run format:check` clean; CHANGELOG and ROADMAP
reflect what shipped vs. what remains.

---

## Suggested delegation order

1. Parallel: **VPH-60**, **VPH-61**.
2. Parallel: **VPH-62 → VPH-63** (server) alongside **VPH-64 → VPH-65** (client).
3. **VPH-66** (demo).
4. **VPH-67** (docs).
   </content>
