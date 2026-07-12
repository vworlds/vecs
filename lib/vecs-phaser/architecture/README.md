# vecs-phaser — Architecture

**Status: shipped.** This document tracks the implemented design of the
Phaser trio — the wire components, the client render/game modules, and the
server glue — as of the `phaser` feature series (wire types 1–35). Usage
guides live in [`../docs`](../docs/README.md); this file records the
decisions, invariants, and testing strategy.

---

## 1. Intent

A **Phaser 4 game kit driven by replicated vecs ECS state**. The server owns
authoritative entities and describes them with small networked components in
meters; the client turns them into Phaser GameObjects, camera state, audio,
and particles **with no per-entity client code**. The stack covers the full
loop of a simple multiplayer game: rendering, animation, audio, camera,
screen-space UI, one-shot effects, and a typed input pipeline.

### In scope (shipped)

Primitive shapes, `Text`, textured `Image`, animated `Sprite`, `Container`
parenting (`DrawIn`/`DrawBy`/`Offset`), display state (`Hidden`, `Flip`,
`Origin`, `Tint`, `Alpha`, `Depth`, `Scale`, `Size`), screen-space
`ScreenAnchor`, server-driven cameras (`CameraFollow`/`Zoom`/`Bounds`/
`Shake`), audio (`Sound`/`Music`), `ParticleBurst`, the asset catalog
(Tiled tilesets + audio over HTTP), the input toolkit
(`InputCaptureModule` → `InputDecodeModule`/`PlayerInput`), the session
handshake (`ClientWorld.sessionEntity()`), and the server `Lifetime` helper.

### Out of scope (see repo [`ROADMAP.md`](../../../architecture/ROADMAP.md))

Dynamic (runtime-added) assets, full Tiled `.tmj` maps, image-collection
tilesets, physics bodies from Tiled collision objects, multi-scene
rendering, renderer batching, client-side prediction, replicated visibility
(views remain the only mechanism), wire quantization.

---

## 2. Package architecture

```
@vworlds/vecs-phaser            (data-only)     deps: vecs, vecs-wire
  │  35 networked components + protocol arrays + input contract + catalog schema
  ▼
@vworlds/vecs-phaser-client     (browser)       deps: vecs-phaser, vecs-client   peer: phaser@^4.1
  │  PhaserRenderModule (+ per-shape modules, SyncModule, Display*, ScreenAnchorModule)
  │  CameraModule · AudioModule · EffectsModule · InputCaptureModule
  │  CoordSpace · loadAssets/Catalog · phaserInterpolators
  ▼
@vworlds/vecs-phaser-server     (node)          deps: vecs-phaser, vecs-server, vecs-physics, vecs-protocol   peer: express (optional)
     PhaserServerModule · InputDecodeModule/PlayerInput · Lifetime/LifetimeModule
     AssetManager (TilesetAsset, AudioAsset) + catalog/static HTTP serving
```

The data package never imports `phaser`; the client keeps `phaser` as a
peer dependency and imports it only in modules that construct GameObjects.
`CoordSpace` uses plain math (no `Phaser.Math`).

---

## 3. Locked design decisions

1. **Meters, +y up, radians CCW+ everywhere; pixels only at the frontier.**
   All conversion (PPM, Y-flip, angle negation, screen anchoring, camera
   bounds) lives in the client behind `CoordSpace`. Screen-pixel exceptions,
   chosen deliberately: `Text.fontSize` and `StrokeStyle.width`.
2. **`phaserNetworkComponents` order is the protocol** (wire id = index+1),
   append-only, pinned by a snapshot test. Current tail: …22 `DrawBy`,
   23 `Hidden`, 24 `Flip`, 25 `Origin`, 26 `ScreenAnchor`, 27–30 camera,
   31 `Sprite`, 32 `Animation`, 33 `Sound`, 34 `Music`, 35 `ParticleBurst`.
3. **The GameObject is the component.** Live Phaser objects attach to their
   entity via `entity.attach(obj)`; interface markers (`Implements`) give
   every sync system a polymorphic surface; teardown is a single
   `m.GameObject.onRemove → destroy()` hook. Unsupported data on a
   renderable (e.g. `Flip` on a shape) is a silent no-op — the marker
   doesn't match.
4. **Renderables are exclusive** (`setExclusiveComponents(...phaserRenderableComponents)`,
   installed by `PhaserServerModule`), which also makes type swaps free.
   `Position` and `ScreenAnchor` are likewise exclusive.
5. **Relationships are networked** as u32 entity ids
   (`Relationship.prototype.target` is an `"entity"` wire field registered
   by vecs-protocol); subclass payload fields serialize too (base fields
   first — vecs-wire merges inherited wire fields). Ghost targets are
   created client-side when a child arrives before its parent.
6. **Per-client state rides the session entity.** Camera components are set
   on it server-side; the client resolves "which entity is me" through the
   reserved system RPC (`SESSION_ENTITY_RPC_ID = 1`, answered by every
   `ServerWorld` connection, cached by `ClientWorld.sessionEntity()`).
   System RPC ids 1–100 are suite-reserved; user RPCs start at 101.
7. **Catalog over HTTP, wire carries ids only.** `AssetManager` scans
   `assets/tilesets` (single-image Tiled `.tsj`) and `assets/audio` at boot,
   assigns stable append-only numeric ids, and serves catalog JSON + static
   files on the app's Express instance. The author key never reaches the
   client; Phaser textures/sounds are keyed by `String(id)`.
   Tile id == frame index (both row-major). Tile animations are published
   in `SpritesheetDescriptor.animations` with authored ms durations.
8. **Load-then-start.** `await loadAssets(...)` resolves after Phaser's
   loader completes and animations are registered, before `connectDgram` —
   no diff can reference an unloaded asset.
9. **Input is a sanitized latest-state channel.** The shared `InputPayload`
   (`{ a, px, py, pd }`) + ordered-action-list contract lives in the data
   package; `InputCaptureModule` fills it (keyboard via the caching
   `addKey`, pointer in world meters via `CoordSpace` inverses),
   `InputDecodeModule` masks/clamps it into the server-local `PlayerInput`.
   Reliable commands use user RPC instead.
10. **One-shots are short-lived entities.** `Sound`/`ParticleBurst`/animated
    explosion sprites are spawned with a server `Lifetime` and destroyed by
    countdown; baseline resends therefore cannot replay stale one-shots.
    `CameraShake` (on the long-lived session entity) documents the
    remove-after-a-few-ticks pattern.
11. **Interpolation is opt-in** (`phaserInterpolators()` → `Position`
    linear, `Rotation` shortest-arc); everything else snaps. No prediction.

---

## 4. Client module map

`PhaserRenderModule` (umbrella) registers markers + `Implements`
declarations, then loads: `DisplaySetupModule` (relationship policy,
Container creation, ghost adoption) → per-renderable modules (`Arc`,
`Ellipse`, `Rectangle`, `Polygon`, `Line`, `Triangle`, `Star`, `Text`,
`Image`, `Sprite`) → `DisplayModule` (display-list placement for
root/native/computed cases) → `OffsetResolveModule` (computed parenting) →
`ScreenAnchorModule` (HUD placement + resize re-layout) → `SyncModule`
(shared transform/style/visibility syncs). All render systems run in
`ON_STORE`; creation precedes sync within the phase, giving same-tick
initialization via `update({ onEnter: true })`.

Optional, registered by the app: `CameraModule` (session-gated reactive
zoom/bounds/shake + per-tick follow), `AudioModule` (`Sound` one-shots;
`Music` via the `MusicPlayback` wrapper's remove hook), `EffectsModule`
(`ParticleBurst` expansion), `InputCaptureModule`.

Server side, `PhaserServerModule` stays zero-config: exclusivity groups +
two `POST_UPDATE` reactive pose-sync systems (vecs-physics
`Position`/`Rotation` → render pose, change-driven, never creating).

---

## 5. Testing strategy

- **vecs-phaser**: wire round-trips per component (including the
  `CameraFollow` target+payload inheritance case), the protocol order
  snapshot (35 entries), renderable-set membership, input mask helpers,
  catalog schema type checks.
- **vecs-phaser-client**: everything headless against the recording Phaser
  stub (vitest aliases `phaser`): create/update/destroy per renderable,
  same-tick init, type swaps, hidden/flip/origin, screen anchoring +
  resize, camera follow/zoom/bounds/shake gating, audio lifecycle,
  particle expansion, input capture (keys, pointer meters, `LocalInput`),
  `loadAssets` ordering + animation registration, `CoordSpace` math.
- **vecs-phaser-server**: exclusivity, pose sync, tileset/audio ingestion
  (fixtures + temp dirs), descriptor DTOs, input decode sanitization,
  lifetime expiry.
- **End-to-end**: the Tank Arena demo's integration tests run the real
  physics engine through spawn → drive → fire → ricochet → kill → score →
  explosion → respawn (`apps/demo-server/tests/game.test.ts`), plus the
  session RPC and relationship-payload tests in vecs-client/vecs-server.
- Repo gates: `npm run lint|typecheck|test|format:check|build`.

---

## 6. Demo apps

- **`apps/client` + `apps/server`** — the original feature showcase
  (balls/players/interest-management grid, joints, bricks). Unchanged.
- **`apps/demo-client` + `apps/demo-server`** — **Tank Arena**, the teaching
  demo built on the full kit; see its READMEs and the
  [design guide](../docs/design-guide.md) it illustrates.
