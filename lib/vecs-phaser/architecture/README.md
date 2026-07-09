# vecs-phaser — Architecture

**Status:** shipped. This document tracks the implemented design of the Phaser rendering
layer and the server-owned asset catalog.

---

## 1. Intent

A thin **Phaser 4.1 rendering layer driven by replicated vecs ECS state**, plus a
**server-owned asset catalog** so the server can refer to assets on the wire by short
numeric resource ids.

The server owns authoritative entities and adds _render components_
(`Position`, `Arc`, `Text`, `Image`, …). The client receives those components through
`@vworlds/vecs-client` and **automatically creates, updates, and destroys Phaser GameObjects**
— with **no per-entity render code**. Textured entities (`Image`) reference the asset
catalog by id; the client loads every asset over HTTP before the world starts and renders
textures with no per-entity client code, exactly like the primitive shape renderers.

This is "server-driven UI for a Phaser scene": the server says _what exists, where
it is, and what it looks like_; the client owns the Phaser lifecycle. It is the rendering
foundation for the larger goal — **multiplayer games that can be authored and modified while
they are played**, because the client is synced to a live ECS (create/destroy entities, add
components, etc., all reflect on screen instantly).

### What is out of scope here

Multi-scene, animated `Sprite`, dynamic (runtime-added) assets, texture atlases with named
frames, audio, full Tiled `.tmj` map parsing, image-collection tilesets, Phaser physics,
client-authoritative render state, replicated visibility (we keep `View`/`EntityTracker`),
full Phaser API mirroring, and wire quantization. Forward-looking items live in the
repo [`ROADMAP.md`](../../../architecture/ROADMAP.md); completed work lives in
[`CHANGELOG.md`](../../../architecture/CHANGELOG.md).

---

## 2. Verified facts (source of truth)

These were confirmed by reading the code; implementers can rely on them.

| Fact                                                                                                                                                              | Where                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Client applies replicated snapshots via `entity.attach()`                                                                                                         | `lib/vecs-client/src/client_world.ts:230`                                                                        |
| `_attach` fires `onAdd`/`onSet` and routes query `enter`/`modified`/`exit` ("as if `set`")                                                                        | `lib/vecs/src/entity/entity.components.ts:19-30`, `:386-399`                                                     |
| Baseline reset destroys all networked entities (→ fires our `exit`) then rebuilds                                                                                 | `lib/vecs-client/src/client_world.ts:208,255-257`                                                                |
| `reset` event: `{ initial, fromFrame, toFrame }`                                                                                                                  | `client_world.ts:211`                                                                                            |
| EIDs are stable across the wire (`getOrCreateEntity(snapshot.eid)`)                                                                                               | `client_world.ts:232`                                                                                            |
| Snapshots emitted in `networkComponents` registration order                                                                                                       | `lib/vecs-server/src/server_world.ts:280`                                                                        |
| Network wire type id = array index + 1 (order is the protocol)                                                                                                    | `lib/vecs-protocol/src/network_world.ts`                                                                         |
| Native exclusivity group: `world.setExclusiveComponents(...)`                                                                                                     | `lib/vecs/src/world/world.components.ts:101`                                                                     |
| `_storeComponent` auto-removes conflicting exclusive components                                                                                                   | `entity.components.ts:402-426`                                                                                   |
| Decorator import: `import { wireType } from "@vworlds/vecs-wire"`                                                                                                 | `lib/vecs-wire/src/index.ts:2`                                                                                   |
| Wire scalar types: `bool,u8,i8,u16,i16,u32,i32,u64,i64,enum,f32,f64,string,bytes,any`; arrays `["f32"]`; nested classes                                           | `lib/vecs-wire/src/decorators.ts`                                                                                |
| No client interpolators are registered by default; callers opt in per wire type via `interpolators` (e.g. `phaserInterpolators()` installs `Position`+`Rotation`) | `lib/vecs-client/src/client_world.ts` (`ClientWorldOptions.interpolators`), `lib/vecs-phaser-client/src/sync.ts` |
| `Relationship.target` is an `Entity` (not serializable); `Encoder.write` throws without `wireEncode` → relationships are **not** networkable                      | `lib/vecs/src/component_meta.ts:11-13`, `lib/vecs-wire/src/encoder.ts:271`                                       |
| vecs-physics pose: `Position {x,y}` (meters), `Rotation {angle}` (radians)                                                                                        | `lib/vecs-physics/src/components/body.ts`                                                                        |
| System/query API: `.with().enter().update().exit().each().run().phase()`                                                                                          | `lib/vecs/src/system.ts`, `lib/vecs/src/query/query.ts`                                                          |
| `update({ watch })` auto-adds the watched component to the query predicate                                                                                        | `lib/vecs/src/query/query.ts:428`                                                                                |
| `connectDgram` performs an HTTP handshake against `worldPath(apiBasePath, worldName)` before the channel opens                                                    | `lib/vecs-client/src/client_world.ts:105`                                                                        |
| The dgram transport is WebRTC datachannel with HTTP signaling mounted on the app's Express instance                                                               | `node_modules/@vworlds/dgram-server/.../socket-listener.js`                                                      |
| Phaser: `scene.load.spritesheet(key, url, { frameWidth, frameHeight, margin, spacing })`; frames are row-major numeric                                            | Phaser `SpriteSheetFile`                                                                                         |
| Phaser: `scene.add.image(x, y, key, frame)` / `image.setTexture(key, frame)` / `setDisplaySize(w, h)`                                                             | Phaser `ImageFactory`, `Texture` component                                                                       |
| Tiled standalone tileset (`.tsj`): `image`, `imagewidth/height`, `tilewidth/height`, `margin`, `spacing`, `columns`, `tilecount`, sparse `tiles[]`                | https://doc.mapeditor.org/en/stable/reference/json-map-format/                                                   |
| Tiled tile local id ordering is **row-major** → tile id == Phaser spritesheet frame index                                                                         | Tiled JSON reference; Phaser `SpriteSheetFile`                                                                   |

---

## 3. Locked design decisions

1. **No scenes in MVP.** One configured Phaser scene. Drop `Scene`/`InScene` and all
   relationship networking (relationships are not wire-encodable). Multi-scene is future work.
2. **Adapter = vecs systems/queries** on the `ClientWorld` (not component hooks), for
   explicit control over _when_ things run.
3. **Render-only MVP.** Live entity/component editing already works through the ECS; live
   _system_ hot-deploy is a separate later capability.
4. **f32 on the wire, server units everywhere.** All spatial fields are plain
   `@wireType("f32")` in **meters, +y up, math convention**. No encode-time conversion.
   Quantization (i16/i32) is a later optimization.
5. **All PPM / Y-flip / centering lives only at the client→Phaser frontier**, behind a
   `CoordSpace` helper — the single place that knows about pixels.
6. **Reversible "frontier" choices** (call out at review if changed): `Text.fontSize` and
   `StrokeStyle.width` are **screen pixels** (crisp text/strokes); `Text` origin normalized
   to `0.5` so `Position` means "center" for every object type; all component **angles are
   radians** (CCW+); Arc start/end angles converted to degrees at the frontier.
7. **Catalog over HTTP, not the binary wire.** The server serves a per-world catalog JSON;
   the client fetches it and drives the Phaser loader. The datachannel stays state-only.
8. **Author key → typed handle → server-assigned numeric id.** Server code refers to assets
   by a human key (`"ship"`); `AssetManager.getTileset("ship")` returns a typed `TilesetAsset`
   handle carrying the stable numeric `id`. The wire carries only the number; the client
   registers Phaser textures keyed by the **id**, so the author key never reaches the client.
9. **Load-then-start.** `await loadAssets(...)` resolves only when every asset is loaded, so
   no diff can reference an unloaded texture. Enforced by ordering, not by per-frame guards.
10. **Append-only id space.** Ids are server-assigned and never reused or reordered, so a
    future in-band "asset added" message can extend the catalog at runtime without a protocol
    break.

---

## 4. Coordinate model

Components carry **meters, +y up** on both server and client. Conversion to Phaser
pixels happens _only_ when calling Phaser setters, via `CoordSpace` (in the client
package) parameterized by `PPM` (default 64) and the live scene size. Server origin
`(0,0)` maps to scene **center**; +y is up.

```
x(mx)  = cx + PPM·mx          cx = scene.scale.width  / 2
y(my)  = cy − PPM·my          cy = scene.scale.height / 2     (Y flip)
len(m) = PPM·m                radius / width / height / star radii
rx(mx) = PPM·mx               relative geometry (polygon/line/triangle verts), no center
ry(my) = −PPM·my              relative geometry, flip
rot(rad) = −rad               → setRotation (radians; flip inverts spin)
deg(rad) = (−rad)·180/π       → Arc setStartAngle/EndAngle (degrees; flip)
```

> **Why negate angles:** flipping the Y axis inverts handedness, so a math-positive
> (CCW) rotation must render as `−angle` or shapes spin the wrong way. Full circles
> (0…2π) are visually unaffected; partial arcs and rotating bodies are not.

Worked example (canvas 1024×768, PPM 64): `(0,0)→(512,384)`, `(1,0)→(576,384)`,
`(0,1)→(512,320)`.

`CoordSpace` uses **plain math, not `Phaser.Math`**, so the client library keeps
`phaser` as a _type-only peer dependency_ (no Phaser runtime import in the lib;
the app provides the `Phaser.Scene` instance and `phaser` runtime).

---

## 5. Package architecture

Three packages; the **server package is thin and may be deferred**. Follow existing
`lib/vecs-*` conventions (package.json shape, `tsconfig.json`/`tsconfig.build.json`,
vitest, `src/`+`tests/`, paths in root `tsconfig.base.json`, entry in root `workspaces`
build script).

```
@vworlds/vecs-phaser            (data-only)   deps: vecs, vecs-wire
        │  components + protocol arrays + TextAlign + catalog schema   no phaser/client/server
        ▼
@vworlds/vecs-phaser-client     (render module) deps: vecs-phaser, vecs-client
        │  PhaserRenderModule, CoordSpace, interface markers, loadAssets  peer: phaser@^4.1
        ▼
@vworlds/vecs-phaser-server     (helpers, optional)  deps: vecs-phaser, vecs-server, vecs-physics, vecs-protocol
        │  PhaserServerModule + AssetManager/Tiled ingestion/HTTP serving  peer: express
```

> **Note (intentional):** `vecs-phaser-server` expands beyond its earlier "thin pure-ECS,
> no deps" character by owning the asset catalog — Tiled ingestion and HTTP serving. It
> also depends on `vecs-physics` (the pose-sync systems read its `Position`/`Rotation`) and
> `vecs-protocol` (`worldPath` for the catalog routes). The ECS helpers (`PhaserServerModule`)
> stay importable on their own.

### 5.1 Public API surface (the contract)

**`@vworlds/vecs-phaser`**

```ts
// Components (see §6)
export class Position {
  /* x,y */
}
export class Rotation {
  /* angle */
}
export class Scale {
  /* x,y */
}
export class Alpha {
  /* value */
}
export class Depth {
  /* value */
}
export class FillStyle {
  /* color, alpha */
}
export class StrokeStyle {
  /* color, alpha, width */
}
export class Arc {
  /*…*/
}
export class Ellipse {} // tag — dimensions live on the shared Size component
export class Rectangle {} // tag — dimensions live on the shared Size component
export class Polygon {
  /*…*/
}
export class Line {
  /*…*/
}
export class Triangle {
  /*…*/
}
export class Star {
  /*…*/
}
export class Size {
  /* width, height (meters) — shared by Ellipse & Rectangle */
}
export class Text {
  /*…*/
}
export enum TextAlign {
  Left = 0,
  Center = 1,
  Right = 2,
}
export class Image {
  /* texture: u32, frame: u16 — indexes the asset catalog */
}
export class Tint {
  /* topLeft, topRight, bottomLeft, bottomRight: u32 = 0xffffff; monochromatic: bool = true */
  /* value setter writes all four corners and sets monochromatic = true */
}

// Protocol arrays — ORDER IS PROTOCOL (wire type id = index + 1)
export const phaserNetworkComponents: readonly ComponentClass[];
export const phaserRenderableComponents: readonly ComponentClass[];

// Asset catalog schema (JSON over HTTP; no @wireType)
export interface AssetDescriptor {
  id: number;
  kind: string;
}
export interface SpritesheetDescriptor extends AssetDescriptor {
  kind: "spritesheet";
  image: string;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
  columns: number;
  tileCount: number;
  imageWidth: number;
  imageHeight: number;
}
export interface AssetCatalog {
  worldName: string;
  assets: AssetDescriptor[];
}
```

**`@vworlds/vecs-phaser-client`**

```ts
export class CoordSpace {
  constructor(scene: Phaser.Scene, ppm?: number);
  x(mx: number): number;
  y(my: number): number;
  len(m: number): number;
  rx(mx: number): number;
  ry(my: number): number;
  rot(rad: number): number;
  deg(rad: number): number;
}
export interface PhaserRenderModuleConfig {
  scene: Phaser.Scene;
  pixelsPerMeter?: number; // default 64
  catalog?: Catalog; // resolved asset catalog (id → descriptor lookup)
}
export class PhaserRenderModule extends Module<PhaserRenderModuleConfig> {
  init(config: PhaserRenderModuleConfig): void;
}
export interface LoadAssetsOptions {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  apiBasePath?: string;
  onProgress?: (value: number) => void;
}
export function loadAssets(scene: Phaser.Scene, conn: LoadAssetsOptions): Promise<Catalog>;
export class Catalog {
  constructor(catalog: AssetCatalog);
  get worldName(): string;
  all(): readonly AssetDescriptor[];
  get(id: number): AssetDescriptor | undefined;
  has(id: number): boolean;
}
export function phaserInterpolators(options?): Array<readonly [number, ComponentInterpolator]>;
export const rotationInterpolator: ComponentInterpolator;
```

The live Phaser GameObject is attached to its entity **as the component** (see §7). The
interface markers it dispatches through (`GameObject`, `Transform`, `Fill`, `Stroke`,
`Size`, `Arc`, `Vertices`, `Star`, `Text`, `Texture`) are internal to the client package.

**`@vworlds/vecs-phaser-server`** (optional)

```ts
export class PhaserServerModule extends Module<undefined> {
  // zero-config: sets exclusive renderable components + two POST_UPDATE reactive
  // pose-sync systems (copies vecs-physics Position/Rotation → render Position/Rotation)
}
export class AssetManager {
  constructor(options: { assetsPath: string });
  getTileset(key: string): TilesetAsset;
  toCatalog(worldName: string, apiBasePath?: string): AssetCatalog;
  mount(app: Express, worldName: string, apiBasePath?: string): void;
}
export class Asset {
  id: number;
  key: string;
  descriptor(): AssetDescriptor;
} // base class
export class TilesetAsset extends Asset {
  image: string;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
  columns: number;
  tileCount: number;
  imageWidth: number;
  imageHeight: number;
  name: string;
  class: string;
  properties: AnyProperty[];
  descriptor(): SpritesheetDescriptor;
  tile(id: number): Tile | undefined;
  sizeInMeters(ppm: number): { w: number; h: number };
}
export class Tile {
  readonly id: number;
  class: string;
  properties: AnyProperty[];
  objects: Map<number, MapObject>;
  animation: Frame[];
}
export class MapObject {
  readonly id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  name: string;
  type: string;
  ellipse: boolean;
  point: boolean;
  polygon: Point[];
  polyline: Point[];
}
// Typed errors: TilesetNotFoundError, AssetKindMismatchError, ImageCollectionTilesetError
// Vendored Tiled schema types: Property, AnyProperty, PropertyType, Frame, Point, Tile, Tileset
```

---

## 6. Component specifications

All components are plain classes with `@wireType` fields (no custom codecs).
**Registration order = `phaserNetworkComponents` order = network protocol**, and it is
_also_ the enter-init invariant (transform+style before shapes; see §7.2).

```ts
export const phaserNetworkComponents = [
  Position,
  Rotation,
  Scale,
  Alpha,
  Depth, // type 1..5
  FillStyle,
  StrokeStyle, // type 6..7
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text, // type 8..15
  Size, // type 16 — dimensions for Ellipse/Rectangle (appended after Text)
  Image, // type 17 — textured renderable (appended after Size)
  Tint, // type 18 — multiplicative tint (appended after Image)
] as const;

export const phaserRenderableComponents = [
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text,
  Image,
] as const;
```

| Component     | Fields (wire type)                                                                                                                                           | Units / notes                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `Position`    | `x:f32=0`, `y:f32=0`                                                                                                                                         | meters, +y up. Type 1; interpolation opt-in via `phaserInterpolators()`.                |
| `Rotation`    | `angle:f32=0`                                                                                                                                                | radians, CCW+. Frontier `rot()` negates.                                                |
| `Scale`       | `x:f32=1`, `y:f32=1`                                                                                                                                         | unitless multiplier                                                                     |
| `Alpha`       | `value:f32=1`                                                                                                                                                | 0..1                                                                                    |
| `Depth`       | `value:i32=0`                                                                                                                                                | render order (unitless)                                                                 |
| `FillStyle`   | `color:u32=0xffffff`, `alpha:f32=1`                                                                                                                          | RGB int                                                                                 |
| `StrokeStyle` | `color:u32=0xffffff`, `alpha:f32=1`, `width:f32=1`                                                                                                           | width in **screen px**                                                                  |
| `Arc`         | `radius:f32=0.5`, `startAngle:f32=0`, `endAngle:f32=2π`, `anticlockwise:bool=false`, `iterations:f32=0.01`                                                   | radius meters; angles radians                                                           |
| `Ellipse`     | _tag_ (no fields) — dimensions on `Size`                                                                                                                     | sized via the shared `Size` component                                                   |
| `Rectangle`   | _tag_ (no fields) — dimensions on `Size`                                                                                                                     | sized via the shared `Size` component                                                   |
| `Polygon`     | `points:["f32"]=[]`                                                                                                                                          | alternating x,y meters (relative)                                                       |
| `Line`        | `x1,y1,x2,y2:f32=0`                                                                                                                                          | meters (relative)                                                                       |
| `Triangle`    | `x1,y1,x2,y2,x3,y3:f32`                                                                                                                                      | meters (relative)                                                                       |
| `Star`        | `points:u8=5`, `innerRadius:f32=0.5`, `outerRadius:f32=1`                                                                                                    | radii meters                                                                            |
| `Text`        | `value:string=""`, `fontFamily:string="sans-serif"`, `fontSize:u16=16`, `color:u32=0xffffff`, `backgroundColor:u32=0`, `backgroundAlpha:f32=0`, `align:u8=0` | fontSize in **screen px**; `align`→`TextAlign`                                          |
| `Size`        | `width:f32=2`, `height:f32=1`                                                                                                                                | meters; shared sizing for `Ellipse`/`Rectangle` (type 16)                               |
| `Image`       | `texture:u32=0`, `frame:u16=0`                                                                                                                               | asset-catalog resource id + frame index (type 17)                                       |
| `Tint`        | `topLeft,topRight,bottomLeft,bottomRight:u32=0xffffff`, `monochromatic:bool=true`                                                                            | RGB int per corner; white = no tint; mono mode sends 1 u32, poly mode sends 4 (type 18) |

Exactly one renderable per entity is enforced server-side by
`setExclusiveComponents(...phaserRenderableComponents)` (installed by `PhaserServerModule`). The
client trusts that invariant: each shape's `new` system reacts only to its own renderable, so the
server's exclusivity is what guarantees one GameObject per entity.

**`Image` sizing is "Both":** if the entity also carries `Size` (meters), the `Image` renderer
calls `setDisplaySize(coords.len(width), coords.len(height))`; otherwise it leaves Phaser's
native frame size and the on-screen meters fall out of `nativePx ÷ PPM`. Sizing lives in the
`Image` renderer (§7.6) rather than the shared `Size` sync because Phaser images size via
`setDisplaySize`, whereas the shared sync drives shapes through `setSize` (the `m.Size` marker);
`Image` therefore does **not** declare `Implements` for `m.Size`. It does implement `m.Texture`,
`m.Transform`, `m.Alpha`, and `m.Depth`, so the existing shared sync drives
`Position`/`Rotation`/`Scale`/`Alpha`/`Depth` unchanged. It does **not** implement `m.Fill`/`m.Stroke`,
so `FillStyle`/`StrokeStyle` never target `Image`.

---

## 7. Client render module architecture

### 7.1 Data flow

```
ServerWorld (meters)                         ClientWorld (meters)            Phaser (pixels)
  entity.set(Arc/Position/Image/…)             progress(now, delta)
        │ collect snapshots (order §6)              │ apply() → decode → entity.attach()
        ▼ encode (f32)                              ▼ fires query enter/modified/exit
  StateDiff ── dgram ──────────────────────▶  PhaserRenderModule systems (ON_STORE)
                                                    │ new:   scene.add.*() → entity.attach(obj)
                                                    │ sync:  setPosition/… ── CoordSpace ──▶ mutate
                                                    └ exit:  remove shape data → obj.destroy()
```

The app drives `clientWorld.progress(now, delta)` each frame (from the Phaser scene's
`update` or rAF). `apply()` runs in phase `ON_LOAD`; the render systems run one phase later in
`ON_STORE` and observe the routed enter/modified/exit events. When `phaserInterpolators()` is
passed at connect time, `Position` (and `Rotation`) are interpolated by the `DiffBuffer` _before_
`CoordSpace`, so motion is smooth between server ticks.

### 7.2 Render state: the GameObject **is** the component

There is no wrapper component. The live Phaser GameObject is attached to its entity **as a
component** via `entity.attach(obj)`, keyed by its concrete Phaser class (e.g.
`Phaser.GameObjects.Arc`, `Phaser.GameObjects.Image`). It is not networked and carries no
`@wireType` fields. Systems never look it up by concrete class — they reach it through
**interface markers**.

**Interface markers (`Implements`).** `markers.ts` declares abstract marker classes whose method
signatures mirror the Phaser GameObject API the renderer calls: `GameObject`, `Shape`,
`Transform`, `Alpha`, `Depth`, `Fill`, `Stroke`, `Size`, `Arc`, `Vertices`, `Star`, `Text`,
`Texture`, `Tint`. At module init each concrete Phaser class declares which markers it satisfies:

```ts
world.component(m.Shape).set(Implements, {
  interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth, m.Fill, m.Stroke],
});
world.component(Phaser.GameObjects.Arc).set(Implements, { interfaces: [m.Shape, m.Arc] });
world.component(Phaser.GameObjects.Text).set(Implements, {
  interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth, m.Text, m.Tint],
});
world.component(Phaser.GameObjects.Image).set(Implements, {
  interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth, m.Texture, m.Tint],
});
```

A query on a marker (`.with(Position, m.Transform)`, `inject: [m.Transform]`) then matches **any**
entity whose attached GameObject implements that marker and injects the live object, typed to the
marker's setters. This is how one shared sync system drives every renderable polymorphically — no
per-type branching.

**Destruction is one hook.** `world.component(m.GameObject).onRemove((_e, obj) => obj.destroy())`
is registered once. Whenever the attached GameObject leaves an entity — explicit remove,
exclusivity swap, or entity destruction — it is destroyed. `clearAllEntities()` therefore tears
everything down for free.

**Per-renderable systems (one module per shape).** Each shape module wires three things:

- A shape-data remove hook: `world.component(Arc).onRemove(e => e.remove(Phaser.GameObjects.Arc))`.
  When the shape **data** component leaves (exclusivity swap or destroy), it removes the attached
  Phaser object, which triggers the `GameObject.onRemove` destroy above.
- `phaser.new.<kind>` — `.with(<Shape>).without(Phaser.GameObjects.<Kind>).phase(ON_STORE)`; on
  `.enter` calls `scene.add.<kind>(…)` (origin set to `0.5`, or `0,0` for vertex shapes) and
  `entity.attach(obj)`.
- `phaser.render.<kind>.geometry` — `.with(<Shape>, m.<marker>).phase(ON_STORE)`; on
  `update({ watch: <Shape>, inject: [m.<marker>] })` mutates the geometry. Only shapes with mutable
  geometry have one: **Arc, Line, Polygon, Triangle, Star, Text**. `Rectangle`/`Ellipse` have no
  geometry system — their only dimension is `Size`, resized through the shared `Size` sync.

**Shared transform/style sync (`SyncModule`).** One system per cross-cutting component, each
matching the data component **plus the interface marker** and calling the injected object's setter:
`Position`/`Rotation`/`Scale` → `m.Transform`, `Alpha` → `m.Alpha`, `Depth` → `m.Depth`, `Size` →
`m.Size`, `FillStyle` → `m.Fill`, `StrokeStyle` → `m.Stroke`, `Tint` → `m.Tint` (only on
GameObjects that mix in Phaser's Tint component: `Image` and `Text`; primitive shapes do
not have `setTint`). Each uses
`update({ watch: <Data>, onEnter: true, inject: [m.<marker>] })`.

**Enter-init invariant.** Protocol order puts transform+style before shapes (§6), the `new` system
attaches the object in `ON_STORE`, and the sync systems (also `ON_STORE`, `onEnter: true`) run
after it within the same phase — so a pre-present `Position`/`FillStyle`/`Size` initializes the
GameObject in the **same tick** it is created. Initialization is query-driven, not manual.

Renderable **type change** (e.g. `Arc`→`Rectangle`): exclusivity (set by `PhaserServerModule`,
§8) auto-removes the old renderable data component → its `onRemove` removes the old Phaser object
→ the `GameObject.onRemove` hook destroys it; the new shape's `new` system creates the replacement.
The swap is driven entirely by component hooks at the mutation site, so no system-registration
ordering is required.

### 7.3 Reset

Baseline reset or disconnect destroys/clears networked entities → each renderable's shape-data
and attached Phaser-object components leave → the `GameObject.onRemove` hook destroys the
GameObjects. Reconnect builds a fresh `ClientWorld` and registers `PhaserRenderModule` again. No
separate reset handler or entity-id object registry is needed.

### 7.4 Interpolation

No interpolators are registered by default. `phaserInterpolators()` (from
`vecs-phaser-client`) opts in: it installs `interpolatePosition` (linear `{x,y}`
lerp) on the `Position` wire type and `rotationInterpolator` (shortest-arc
angular lerp in radians) on the `Rotation` wire type, both looked up from
`phaserNetworkComponents`. Pass it at `ClientWorld.connectDgram` time via
`interpolators: phaserInterpolators()`. Pass
`phaserInterpolators({ interpolateRotation: false })` to snap rotation while
still interpolating `Position`. All other components snap to latest.

### 7.5 Origin & rotation pivot

`Position` is the **entity origin** — it maps to the Box2D body transform that
`PhaserServerModule`'s pose-sync copies, and it is the **rotation pivot** for every shape (`Rotation`
rotates about it, matching Box2D bodies). The renderer must guarantee this uniformly:

- **Centered primitives** (`Arc`, `Ellipse`, `Rectangle`, `Star`, `Image`): Phaser already centers
  these on the GameObject position (origin 0.5) — matches Box2D circle / `SetAsBox`.
- **`Text`**: Phaser anchors top-left (0,0); the Text renderer calls `setOrigin(0.5)` so
  `Position` is the center, like every other shape.
- **Vertex shapes** (`Polygon`, `Line`, `Triangle`): vertices are offsets from `Position`
  in vertex-space `(0,0)` — the Box2D body-local convention (symmetric verts ⇒ centered,
  asymmetric ⇒ intentionally offset). **Phaser does not honor this by default**: it anchors
  a Polygon on the _center of its points' bounding box_, and `getBounds` misbehaves when
  points are negative. The renderer must therefore **pin vertex-space `(0,0)` to `Position`
  and keep the rotation pivot there** — position the GameObject at `Position` and set the
  display origin so geometry-local `(0,0)` is the anchor; do **not** rely on Phaser's
  bounding-box centering. The frontier still applies `rx/ry` (scale + Y-flip) to the
  vertices and negates the angle.

### 7.6 Image renderer

`src/modules/image.ts` mirrors the shape renderers' attach + interface-marker lifecycle:

- **Init wiring:** the `Texture` interface marker (`setTexture`/`setDisplaySize` in `markers.ts`);
  `Phaser.GameObjects.Image` declares `Implements` for `m.GameObject, m.Transform, m.Alpha,
m.Depth, m.Texture`; and the shape-data remove hook
  `world.component(Image).onRemove(e => e.remove(Phaser.GameObjects.Image))` (which triggers the
  shared `GameObject.onRemove → destroy`).
- `phaser.new.image`: `.with(Image).without(Phaser.GameObjects.Image).phase(ON_STORE)`; on
  `.enter`, `entity.attach(scene.add.image(0, 0, String(texture), frame).setOrigin(0.5))`.
- `phaser.render.image.texture`: `.with(Image, m.Texture).phase(ON_STORE)`; on
  `update({ watch: Image, inject: [m.Texture] })`, call `setTexture(String(texture), frame)`.
- `phaser.render.image.size`: `.with(Image, m.Texture).phase(ON_STORE)`; on
  `update({ watch: Size, onEnter: true, inject: [m.Texture] })`, apply `setDisplaySize` from
  `Size`. When `Size` is absent the system does not match (the watched component auto-joins the
  query predicate), so native size is left untouched.
- **No per-renderer `.exit`:** teardown flows through the shape-data remove hook → the shared
  `GameObject.onRemove → destroy`, exactly like the shape renderers.

The **Phaser texture key is the resource id** (`String(id)`), so the renderer maps
`Image.texture` → key with no author-key knowledge. The render module accepts the resolved
`catalog` (optional) so it can validate ids and later resolve descriptor metadata; rendering itself
needs only the texture key + frame.

---

## 8. Server-side usage (pure ECS)

```ts
import { ServerWorld } from "@vworlds/vecs-server";
import { PhaserServerModule } from "@vworlds/vecs-phaser-server";
import { phaserNetworkComponents, Arc, Position, FillStyle } from "@vworlds/vecs-phaser";

const world = new ServerWorld({ name: "main", networkComponents: phaserNetworkComponents });
world.module(PhaserServerModule); // owns exclusivity + reactive pose-sync in POST_UPDATE

world
  .entity()
  .add(Networked)
  .set(Arc, { radius: 0.25 }) // meters
  .set(Position, { x: 1.5, y: 1.0 }) // meters, +y up
  .set(FillStyle, { color: 0xffcc00, alpha: 1 });
```

The `PhaserServerModule` (zero-config) handles everything in one call:

- Sets exclusive renderable components (one shape per entity).
- Installs two reactive pose-sync systems in `POST_UPDATE` that copy
  `vecs-physics` `Position`/`Rotation` → render `Position`/`Rotation` only
  when physics actually changed the body pose (`update({ watch, onEnter: true })`).
  Entities must already have a render pose (set by the user at creation); the
  module never creates render components.

### 8.1 Asset catalog (server-owned)

The server owns the asset catalog. It loads Tiled tilesets by **human key** into typed
`TilesetAsset` handles, assigns stable append-only wire ids, serves the catalog JSON and static
image files over its existing Express app, and refers to assets on the wire by short numeric ids.

```ts
import { AssetManager } from "@vworlds/vecs-phaser-server";
import { Image } from "@vworlds/vecs-phaser";

const assets = new AssetManager({ assetsPath: "assets" });
const bricks = assets.getTileset("bricks"); // parses assets/tilesets/bricks.tsj (.json fallback)
assets.mount(app, world.name); // GET {worldPath}/assets (catalog) + static files

// Use the stable numeric id on the wire; the client keys textures by id.
world.entity().add(Networked).set(Image, { texture: bricks.id, frame: 0 });

// Match a physics body to the art in one call.
const size = bricks.sizeInMeters(PPM); // → { w: tilewidth/ppm, h: tileheight/ppm }
world
  .entity()
  .childOf(body)
  .set(Box, { hx: size.w / 2, hy: size.h / 2 });
```

**Tiled ingestion.** `getTileset(key)` reads `assetsPath/tilesets/<key>.tsj` (falling back to
`<key>.json`) and parses with a `JSON.parse(text, reviver)` whose **reviver constructs the concrete
`TilesetAsset`/`Tile`/`MapObject` instances** (typed against the vendored `src/types/tileset.ts`
interfaces), not plain data bags. The Tiled schema is **vendored, not depended on** — the
bare-minimum interfaces are copied from `@kayahr/tiled` (the authoritative reference), retaining
only the fields actually used and grown field-by-field as features are added. There is no
`@kayahr/tiled` runtime dependency.

**Non-null defaults.** Our interfaces drop Tiled's optionality (`?`) — sparse Tiled fields become
REQUIRED on our interfaces, and the concrete classes guarantee non-null empty defaults
(`[]`, empty `Map`, `""`, `false`, `0`) supplied at construction time, so consumers never null-check.

**Per-tile metadata.** `tileset.tile(id)` returns a `Tile` carrying the per-tile Tiled metadata the
server reads (game-logic data) but the wire never carries: `class` (the "Class" field), typed
`properties: AnyProperty[]` (preserved as-is, not flattened, so declared types like `color`/`int`/
`file` survive), `objects: Map<MapObject.id, MapObject>` (collision/anchor shapes), and
`animation: Frame[]`. Because Tiled tile ids and Phaser spritesheet frame indices are both
row-major, **tile id == frame**, so `set(Image, { texture: ship.id, frame: tileId })` shows that
exact tile.

**Tileset "Class" note.** A tileset's `class` field comes from Tiled's `class` only. A tileset's
top-level `type` is Tiled's file-format discriminator (`"tileset"`/`"map"`), **not** a class, so it
is deliberately not used as a fallback at the tileset level (unlike a _tile_'s `type`, which is that
tile's class and is used as a fallback).

**Scope.** Single-image tilesets only; image-collection tilesets (where individual tiles carry
their own `image`) are rejected with `ImageCollectionTilesetError`. No `.tmj` map parsing.

**Serving.** `mount(app, worldName, apiBasePath?)` registers, under the per-world
`worldPath(apiBasePath, worldName)`:

- `GET {worldPath}/assets` → `toCatalog(worldName, apiBasePath)` JSON (server-only metadata stripped).
- `{worldPath}/assets/files` → `express.static(assetsPath)` (serves every image the catalog
  references).

CORS is already configured at the app level. Image **bytes** are never read server-side — only
metadata; bytes are served over HTTP to the client by `mount`.

**Catalog DTO.** `toCatalog` enumerates loaded assets into the wire `AssetCatalog` DTO. The
catalog travels as JSON over HTTP (so its types carry no `@wireType`), and it lives in
`vecs-phaser` so both ends agree. v1.0.36 has a single asset kind — **spritesheet** — because every
asset is a Tiled tileset. The schema is split by extension: a base `AssetDescriptor` carries the
wire id and discriminant (`id`, `kind`), and `SpritesheetDescriptor extends AssetDescriptor`
narrows `kind` to `"spritesheet"` and adds the load fields, including `image`, the source image
path relative to `assetsPath`. New kinds append a new `*Descriptor extends AssetDescriptor` — the
base never changes. Each concrete server asset owns its descriptor creation through
`Asset.descriptor()`, so `AssetManager.toCatalog` stays agnostic to asset kinds.

**Per-tile Tiled metadata (properties, animations, collision shapes) is intentionally excluded**
from the catalog DTO — it is server-only game-logic data; the client only ever needs `(id, frame)`
to render.

---

## 9. Client asset loading

`loadAssets(scene, conn)` fetches the catalog, queues every spritesheet in Phaser, and resolves a
`Catalog` (an `id → descriptor` lookup) on loader `complete`. It surfaces the loader's progress for a
loading bar. The fetch URL mirrors `connectDgram`'s: `${protocol}://${host}:${port}${worldPath(apiBasePath,
worldName)}/assets`; each descriptor's `image` is asset-root-relative, so each spritesheet is queued
from `${origin}${worldPath(apiBasePath, worldName)}/assets/files/${image}`.

```ts
const catalog = await loadAssets(scene, {
  host: "localhost",
  port: 8080,
  worldName: "main",
  onProgress: (value) => updateLoadingBar(value),
});

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "main",
  networkComponents: phaserNetworkComponents,
  interpolators: phaserInterpolators(),
});
world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100, catalog });
```

`loadAssets` is awaited **before** `connectDgram`, guaranteeing every texture is resident before
the first state diff arrives. The idiomatic structure is a dedicated **boot/loading scene**: a
lightweight `BootScene` does `await loadAssets(scene, conn)` (rendering loader progress as a bar),
then `scene.start("Game", { catalog })` once everything is resident; the game scene connects the
world and registers `PhaserRenderModule` with the passed catalog. This keeps the gameplay scene free
of load bookkeeping. The Phaser loader runs via `load.start()` (not the conventional `preload()`)
because the catalog must be _fetched_ before the loads can be queued.

---

## 10. Demo (`apps/server` + `apps/client`)

The demo (canvas balls/players + 3×3 interest-management grid, server physics-driven in meters) is
migrated to prove the whole stack end to end, now including textured `Image` entities from a real
Tiled tileset.

### Target world model

- World in **meters, origin center, +y up**. Canvas 960×540, **PPM = 100**. World extent ≈
  x∈[−4.8,4.8], y∈[−2.7,2.7].
- `networkComponents = phaserNetworkComponents` **only**. Game-logic markers (`Ball`,
  `Player`) stay **server-local** (registered, not networked) → the client carries _zero_
  game components and renders purely from render components.

### Server (`apps/server/src/main.ts`)

- Express app + CORS; `AssetManager({ assetsPath: "assets" })` → `getTileset("bricks")` →
  `mount(app, world.name)` before `app.listen`.
- `createBrickShowcase()`: a short row of static `Image` bricks at distinct frames (decoration,
  native frame size, no `Size`), plus a batch of dynamic `Image` bricks whose `Box` colliders are
  matched to the art via `bricks.sizeInMeters(PPM)`. Each dynamic brick drops in with a random
  frame, spin, and angular/linear velocity and bounces around the arena (springy restitution).
  `PhaserServerModule` syncs the physics transform back onto the render transform, so no extra
  wiring is needed.
- Existing primitives (`Arc` balls, `Rectangle` players, `Text` scores, decorative
  `Star`/`Triangle`/`Polygon`/`Ellipse`/`Line`) and interest management (`View` DSL, `InCell`, cell
  tags, `viewAll`) remain, in meters.

### Client (`apps/client/src/main.ts`)

- A `Phaser.Game` with scenes `[BootScene, DemoScene]`.
- `BootScene`: draws a progress bar, `await loadAssets(scene, { host, port, worldName,
onProgress })`, then `scene.start("DemoScene", { catalog })`; retries on failure.
- `DemoScene`: `init` captures the catalog; `create` connects `ClientWorld.connectDgram` and
  registers `PhaserRenderModule({ scene, pixelsPerMeter: 100, catalog })`; `update` drives
  `world.setInput` + `world.progress(time, delta)`. Cosmetic grid + instructions drawn with Phaser
  `Graphics`/`Text` (client-only). On disconnect, `clearAllEntities()`; reconnect creates a fresh
  `ClientWorld` and registers the render module again.

### Demonstrates

auto-render from components (shapes + textured `Image`), interpolation (moving balls), rotation
(spinning physics balls + tumbling bricks), `Text` (scores), all primitive shapes, asset loading
with a progress bar, the asset catalog served over HTTP, body-to-art sizing via `sizeInMeters`,
lifecycle create/destroy as entities enter/leave the view (interest management), and baseline-reset
rebuild.

---

## 11. Testing strategy

- **`vecs-phaser`:** per-component wire round-trip (incl. `Polygon` array, `Text` strings,
  `TextAlign`, `Image` texture/frame, `Tint` mono/poly corners); `phaserNetworkComponents` order snapshot
  (pins `Image` at type 17, `Tint` at type 18); `phaserRenderableComponents` membership ==
  primary renderables; catalog schema type-level checks (`SpritesheetDescriptor` narrows
  `kind`, heterogeneous `AssetDescriptor[]`).
- **`vecs-phaser-client`:** `CoordSpace` math ((0,0)→center, (1,0)→+PPM, (0,1)→−PPM, angle
  negation, relative vs absolute). With **mock Phaser** objects (node env, no browser): load
  `PhaserRenderModule` on a `ClientWorld`; create on shape enter; initialize pre-present
  Position/FillStyle through sync-system ordering; transform/style updates apply via
  CoordSpace; destroy on exit/entity clear; recreate on renderable-type change; Text origin
  centered; vertex shapes pin `(0,0)` to `Position`; `Image` create/texture-change/size-present/
  size-absent/position-tracking/exit; `loadAssets` queues `load.spritesheet` for every descriptor,
  resolves only after `complete`, and reports progress.
- **`vecs-phaser-server`:** `PhaserServerModule` enforces exclusivity; reactive pose-sync copies
  physics `Position`/`Rotation` → render (only when physics changed; no create). `AssetManager`
  loads a `.tsj`/`.json` fixture into a live `TilesetAsset` with the correct spritesheet fields +
  resolved image path, caches (same handle on re-get), type-checks (non-tileset under the same key
  throws), rejects image-collection tilesets; `tile(id)` returns a `Tile` with captured `class`,
  typed `properties`, `objects` `Map`, and `animation`; non-null empty defaults when Tiled omits
  fields; ids are stable/append-only; `sizeInMeters`; `descriptor` strips server-only metadata;
  `mount` serves catalog JSON + static files (real Express listen on port 0 + `fetch`); the
  tileset top-level `type` discriminator is not treated as the class.
- **Demo:** manual end-to-end (`npm run dev`): loading scene completes before the world connects,
  then bricks render alongside the existing shapes and the body-matched bricks collide.
- Repo gates: `npm run test|typecheck|lint|format` across workspaces.

---

## 12. Risks & mitigations

| Risk                                                                          | Mitigation                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Frontier conversion (centering, Y-flip, angle negation, relative vs absolute) | Localized in `CoordSpace`; exhaustive unit tests + visual demo check                                                    |
| Component order is protocol **and** enter-init invariant                      | Snapshot test the order; document in code                                                                               |
| New adds after a shape's enter aren't routed to `.update`                     | Enter reads all present components; order guarantees they're there                                                      |
| Vertex-shape origin (Phaser anchors on bounding box, not vertex `(0,0)`)      | Pin vertex `(0,0)` to `Position` & rotation pivot per §7.5; handle asymmetric/negative points                           |
| `Polygon.setTo` rebuilds geometry                                             | Treat as definition data, not per-frame                                                                                 |
| Interpolation cadence (smoothness)                                            | Verify `.update(Position)` fires per frame during interp (existing demo behavior)                                       |
| `phaser` version/peering                                                      | `phaser` is a **type-only peer dep** of the client lib; the app provides the runtime; `CoordSpace` avoids `Phaser.Math` |
| Catalog must exist before the first diff references an id                     | `await loadAssets(...)` before `connectDgram`; the load resolves only on loader `complete`                              |
| Adding `Image` reorders/extends the protocol                                  | Append-only at type 17; the order snapshot test pins it; the bump is documented in CHANGELOG                            |
| Adding `Tint` extends the protocol                                            | Append-only at type 18; the order snapshot test pins it; the bump is documented in CHANGELOG                            |
| Tiled image path is relative to the `.tsj`                                    | Resolved against the `.tsj` directory at load time; served under `assetsPath`                                           |
| Author key vs wire id confusion                                               | Key is server-only sugar; client keys textures by id; tests assert the key never crosses the wire                       |
| Tiled top-level `type` discriminator misread as the tileset class             | Tileset `class` reads `class` only; tile-level `type` stays the tile-class alias; regression test pins it               |

---

## 13. Success criteria

- Server creates entities with shape/text/`Image` components **in meters**; client auto-renders
  them in Phaser with **no per-entity-type render code**.
- Origin-at-center, +y-up meters (server) ↔ y-down pixels (client) is correct and lives only
  at the Phaser frontier.
- `Position`/`Rotation` align with `vecs-physics`; pose-sync is a plain copy.
- `View`/`EntityTracker` remains the only visibility mechanism.
- Baseline reset fully rebuilds GameObjects; works with no image assets.
- Server loads Tiled tilesets by **human key** into typed `TilesetAsset` handles; each handle
  carries a stable numeric id; assets are served over HTTP from the server's existing Express app.
- Client fetches the catalog, loads everything, **then** starts the world; `Image` entities
  render automatically with no per-entity render code.
- "Both" sizing works: `Size` in meters wins; otherwise native pixels ÷ PPM.
- `TilesetAsset.sizeInMeters` lets server game code match a physics body to its art in one call.
- Tiled tile ids map 1:1 to frames; per-tile `class`/`properties`/`objects` are readable
  server-side; `animation` is captured for the future `Sprite` feature.
