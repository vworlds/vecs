# vecs-phaser — Ticket Breakdown

Delegate-ready tickets for the design in [`README.md`](./README.md). Each ticket is
sized for one subagent and states scope, files, dependencies, and acceptance criteria.
**Read `README.md` first** — it is the contract; tickets do not repeat component specs
or the coordinate model.

## Conventions for every ticket

- Match repo rules in `.agent/rules/` (commits, formatting, testing). Test-first where practical.
- Mirror an existing `lib/vecs-*` package for package.json / tsconfig / vitest shape.
- TypeScript strict; ESM; no `any` leaks across public API.
- A ticket is **Done** only when `npm run typecheck`, `lint`, and its `test` pass for its package.

## Dependency graph (waves)

```
W0 scaffolding ─┬─▶ W1 vecs-phaser (data) ─┬─▶ W2 vecs-phaser-client ─┐
                │                           ├─▶ W3 vecs-phaser-server ─┤
                └─▶ VPH-20 CoordSpace ──────┘                          ├─▶ W4 demo ─▶ W5 polish
```

Parallelizable: within W1 the component-group tickets; within W2 the two shape-renderer
tickets; W3 in parallel with W2; VPH-20 may start right after W0.

---

## Wave 0 — Scaffolding

### VPH-1 — Scaffold all three packages + root wiring

**Package:** repo-wide · **Deps:** none · **Parallel:** no (touches shared root files)

Create package skeletons for `@vworlds/vecs-phaser`, `@vworlds/vecs-phaser-client`,
`@vworlds/vecs-phaser-server`, each with `package.json`, `tsconfig.json`,
`tsconfig.build.json`, `vitest.config.ts`, `src/index.ts` (empty export), `tests/.gitkeep`,
`README.md`, `CHANGELOG.md`, `LICENSE`. Copy shape/scripts from an existing `lib/vecs-*`.

- Deps: `vecs-phaser` → `@vworlds/vecs`, `@vworlds/vecs-wire`. `vecs-phaser-client` →
  `@vworlds/vecs-phaser`, `@vworlds/vecs-client`; **`phaser@^4.1.0` as `peerDependency` +
  `devDependency`**. `vecs-phaser-server` → `@vworlds/vecs-phaser`, `@vworlds/vecs-server`.
- Root wiring: add the three `@vworlds/*` paths to `tsconfig.base.json`; add build steps to
  the root `package.json` `build` script (order: after `vecs-server`/`vecs-physics`,
  `vecs-phaser` → `vecs-phaser-server` → `vecs-phaser-client`). `workspaces` already globs `lib/*`.
- Replace the placeholder `lib/vecs-phaser*/README.md` stubs created during planning.

**Acceptance:** `npm install` clean; `npm run typecheck -w @vworlds/vecs-phaser` (and the
other two) pass on empty packages; `npm run build` includes them; the planning
`architecture/` folder is preserved.

---

## Wave 1 — `@vworlds/vecs-phaser` (data-only)

> Each component-group ticket creates its own module under `src/components/` and exports
> from there; **VPH-13 owns `src/index.ts` and the protocol arrays** to avoid index merge
> conflicts. VPH-10/11/12 may run in parallel.

### VPH-10 — Transform + style components

**Deps:** VPH-1 · **Files:** `src/components/transform.ts`, `src/components/style.ts`, `tests/transform.test.ts`, `tests/style.test.ts`

Implement `Position, Rotation, Scale, Alpha, Depth, FillStyle, StrokeStyle` per §6
(plain `@wireType`). **Acceptance:** wire round-trip per component asserts field values
and defaults survive encode→decode.

### VPH-11 — Shape components

**Deps:** VPH-1 · **Files:** `src/components/shapes.ts`, `tests/shapes.test.ts`

Implement `Arc, Ellipse, Rectangle, Polygon, Line, Triangle, Star` per §6, including
`Polygon.points` as `@wireType(["f32"])`. **Acceptance:** round-trip incl. a non-empty
polygon points array and Arc defaults (`endAngle = 2π`).

### VPH-12 — Text component + TextAlign

**Deps:** VPH-1 · **Files:** `src/components/text.ts`, `tests/text.test.ts`

Implement `Text` + `enum TextAlign`. **Acceptance:** round-trip incl. unicode `value`,
empty string, and each `align` value.

### VPH-13 — Protocol arrays + barrel exports

**Deps:** VPH-10, VPH-11, VPH-12 · **Files:** `src/index.ts`, `tests/protocol.test.ts`

Export everything; define `phaserNetworkComponents` and `phaserRenderableComponents` in
the exact §6 order. **Acceptance:** a **snapshot test** pins `phaserNetworkComponents`
names+order (changing it is a deliberate protocol break); a test asserts
`phaserRenderableComponents` equals the 8 primary renderables in order.

---

## Wave 2 — `@vworlds/vecs-phaser-client`

### VPH-20 — `CoordSpace` helper

**Deps:** VPH-1 · **Parallel:** yes (early) · **Files:** `src/coord_space.ts`, `tests/coord_space.test.ts`

Implement `CoordSpace` per §4 using **plain math** (no `Phaser.Math`); read `cx/cy` from
`scene.scale.width/height` each call. **Acceptance:** unit tests for `x/y/len/rx/ry/rot/deg`
with a mock scene (`{ scale: { width, height } }`), including the worked example and angle
negation; resizing the mock scene moves the center.

### VPH-21 — `PhaserRenderModule` core

**Deps:** VPH-13, VPH-20 · **Files:** `src/module.ts`, `src/index.ts`, `tests/module.lifecycle.test.ts`

Implement the render module shell: `PhaserRenderModule`, local `VGameObject`, `CoordSpace`
construction, and a registration point that VPH-22/23/24 plug systems into. Define a
`MockScene`/`MockGameObject` test helper others reuse. **Acceptance:** `world.module(...)`
registers render systems, and removing `VGameObject` destroys the Phaser object. Uses mock
Phaser objects.

### VPH-22 — Shape renderers (set A: Arc, Rectangle, Polygon, Line, Text)

**Deps:** VPH-21 · **Files:** `src/renderers/*.ts`, `tests/renderers.setA.test.ts`

Per-renderable systems: `.enter` (create via `scene.add.<kind>`, init from present
components per §7.2), `.update(<Shape>)` (geometry via CoordSpace), `.exit` (destroy).
Text renderer sets `setOrigin(0.5)`.

**Origin & rotation pivot (per §7.5) — required:** `Position` is the origin and rotation
pivot for every shape. Centered primitives use Phaser's default 0.5 origin. **Vertex shapes
(`Polygon`, `Line`) must pin geometry-local `(0,0)` to `Position`** (and keep the rotation
pivot there) — position the GameObject at `Position` and set its display origin so local
`(0,0)` is the anchor; do **not** rely on Phaser's bounding-box centering. Apply `rx/ry`
(scale + Y-flip) to vertices.

**Acceptance:** entering an `Arc` entity creates an arc sized via `len(radius)`; geometry
updates apply; exit destroys; `polygon.setTo` called with scaled+flipped relative points;
**a `Polygon`/`Line` with _asymmetric_ vertices (and a negative coordinate) renders with
vertex `(0,0)` at `Position`** (assert the GameObject position and origin/offset, not the
bounding-box center); **applying `Rotation` pivots the vertex shape about `Position`** (the
shape does not drift). Use mock Phaser objects.

### VPH-23 — Shape renderers (set B: Ellipse, Triangle, Star)

**Deps:** VPH-21 · **Parallel:** with VPH-22 · **Files:** `src/renderers/*.ts`, `tests/renderers.setB.test.ts`

Same pattern for `Ellipse, Triangle, Star`. `Ellipse`/`Star` are centered primitives;
**`Triangle` is a vertex shape — apply the §7.5 origin & rotation-pivot contract (pin
vertex `(0,0)` to `Position`), same as VPH-22's Polygon/Line.** **Acceptance:**
create/update/exit verified per shape with CoordSpace-scaled dimensions; an asymmetric
`Triangle` renders with vertex `(0,0)` at `Position` and rotates about it.

### VPH-24 — Shared transform/style sync + rotation interpolation

**Deps:** VPH-21 · **Files:** `src/sync.ts`, `tests/sync.test.ts`

Systems `.with(Position|Rotation|Scale|Alpha|Depth|FillStyle|StrokeStyle)` applying the
mapped GameObject setters via CoordSpace (guarding absence). Wire `interpolateRotation`
into the `ClientWorld` `interpolators` for the `Rotation` type id (shortest-arc lerp).
**Acceptance:** Position update → `setPosition(x(mx), y(my))`; Rotation → `setRotation(rot)`;
fill/stroke applied; missing GameObject is a no-op; rotation interpolator registered when enabled.

### VPH-25 — Client integration test (mock Phaser)

**Deps:** VPH-22, VPH-23, VPH-24 · **Files:** `tests/integration.test.ts`

Drive a `ClientWorld` with applied snapshots through the runtime end-to-end with mocks:
enter-init ordering (Position/FillStyle present at shape enter), renderable-type change
recreates, baseline `reset` rebuilds. **Acceptance:** all scenarios pass without a browser.

---

## Wave 3 — `@vworlds/vecs-phaser-server` (optional, parallel with W2)

### VPH-30 — Exclusivity + shape builders

**Deps:** VPH-13 · **Files:** `src/builders.ts`, `src/index.ts`, `tests/builders.test.ts`

`registerRenderExclusivity(world)` wrapping `setExclusiveComponents(...phaserRenderableComponents)`;
builders (`createArc`, `createRectangle`, `createText`, …) adding `Networked` + the one
renderable + optional transform/style. **Acceptance:** builder-made entity carries
`Networked` + intended renderable; setting a second renderable removes the first.

### VPH-31 — `syncPhysicsPose` helper

**Deps:** VPH-13, `@vworlds/vecs-physics` · **Files:** `src/pose.ts`, `tests/pose.test.ts`

System copying vecs-physics `Position`/`Rotation` (meters/radians) → render
`Position`/`Rotation`, only marking modified on change. **Acceptance:** render pose tracks
physics pose; no redundant `modified` when unchanged.

---

## Wave 4 — Demo migration

> Contract between VPH-40/41: `networkComponents = phaserNetworkComponents`; world in
> meters, origin center, +y up; PPM = 100; client carries zero game components.

### VPH-40 — Migrate server demo

**Deps:** W1 (+ VPH-30/31 if used) · **Files:** `apps/server/src/main.ts`, `apps/server/package.json`

Per README §9 server changes: switch to `phaserNetworkComponents`; keep `Ball`/`Player`
local; recenter game math to meters/center-origin; replace pixel `SyncPhysicsBalls` with
`syncPhysicsPose` (render pose = physics pose); map Ball→`Arc`+`FillStyle`,
Player→`Rectangle`+`FillStyle`, score→child `Text`; add static decorative shapes covering
all renderables; preserve interest management (`View` DSL / `InCell` / `viewAll`) in meters.
**Acceptance:** server boots; entities carry render components; typecheck/lint pass.

### VPH-41 — Migrate client demo to Phaser

**Deps:** W2, VPH-40 contract · **Files:** `apps/client/src/main.ts`, `apps/client/index.html`, `apps/client/package.json`

Replace canvas-2D with a Phaser game (one scene, 960×540); connect `ClientWorld` with
`phaserNetworkComponents`; `world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100 })`;
`update()` does `setInput` + `progress`; **delete manual render systems**; keep arrows + `G`;
draw cosmetic grid + instructions with Phaser `Graphics`/`Text`; preserve reconnect handling.
Add `phaser@^4.1.0` to the app. **Acceptance:** `npm run dev` renders balls/players/scores/
decoration; arrows move the player; `G` toggles view; no per-entity render code remains.

### VPH-42 — End-to-end verification + docs

**Deps:** VPH-40, VPH-41 · **Files:** demo READMEs, `architecture/` notes if needed

Run server + client together; verify: origin-at-center & +y-up, smooth interpolated balls,
spinning rotation, scores as Text, all shapes visible, entities create/destroy as they
enter/leave the view, forced baseline reset rebuilds. Capture a screenshot/GIF. Document
run steps. **Acceptance:** checklist verified and recorded.

---

## Wave 5 — Polish

### VPH-50 — Workspace gates + release hygiene

**Deps:** all · **Files:** package versions, CHANGELOGs

`npm run test|typecheck|lint|format` green across workspaces; align package versions with
repo convention; fill CHANGELOGs; confirm `package.json` `exports`/`files` correct for
publish. **Acceptance:** all gates pass; packages are publish-shaped.

---

## Suggested delegation order

1. **VPH-1** (solo).
2. Parallel: **VPH-10, VPH-11, VPH-12, VPH-20**.
3. **VPH-13** → then **VPH-21**.
4. Parallel: **VPH-22, VPH-23, VPH-24** (+ **VPH-30, VPH-31**).
5. **VPH-25**.
6. **VPH-40** → **VPH-41** → **VPH-42**.
7. **VPH-50**.
