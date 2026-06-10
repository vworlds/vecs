# vecs-phaser — Architecture & Plan

**Status:** approved design, pre-implementation
**Audience:** engineering manager + implementing subagents
**Companion:** [`TICKETS.md`](./TICKETS.md) — delegate-ready ticket breakdown

---

## 1. Intent

A thin **Phaser 4.1 rendering layer driven by replicated vecs ECS state**.

The server owns authoritative entities and adds _render components_
(`Position`, `Arc`, `Text`, …). The client receives those components through
`@vworlds/vecs-client` and **automatically creates, updates, and destroys Phaser
GameObjects** — with **no per-entity render code**.

This is "server-driven UI for a Phaser scene": the server says _what exists, where
it is, and what it looks like_; the client owns the Phaser lifecycle. It is the
rendering foundation for the larger goal — **multiplayer games that can be authored
and modified while they are played**, because the client is synced to a live ECS
(create/destroy entities, add components, etc., all reflect on screen instantly).

### Non-goals (MVP)

No scenes/multi-scene, `Image`/`Sprite`, bitmap fonts/atlases/tilemaps,
asset-loading protocol, Phaser physics, client-authoritative render state,
replicated visibility (we keep `View`/`EntityTracker`), full Phaser API mirroring,
or wire quantization. `Image`/`Sprite` and multi-scene are the first post-MVP work.

---

## 2. Verified facts (source of truth)

These were confirmed by reading the code; implementers can rely on them.

| Fact                                                                                                                                         | Where                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Client applies replicated snapshots via `entity.attach()`                                                                                    | `lib/vecs-client/src/client_world.ts:230`                                  |
| `_attach` fires `onAdd`/`onSet` and routes query `enter`/`modified`/`exit` ("as if `set`")                                                   | `lib/vecs/src/entity/entity.components.ts:19-30`, `:386-399`               |
| Baseline reset destroys all networked entities (→ fires our `exit`) then rebuilds                                                            | `lib/vecs-client/src/client_world.ts:208,255-257`                          |
| `reset` event: `{ initial, fromFrame, toFrame }`                                                                                             | `client_world.ts:211`                                                      |
| EIDs are stable across the wire (`getOrCreateEntity(snapshot.eid)`)                                                                          | `client_world.ts:232`                                                      |
| Snapshots emitted in `networkComponents` registration order                                                                                  | `lib/vecs-server/src/server_world.ts:280`                                  |
| Network type id = array index + 1 (order is the protocol)                                                                                    | `lib/vecs-protocol/src/network_world.ts`                                   |
| Native exclusivity group: `world.setExclusiveComponents(...)`                                                                                | `lib/vecs/src/world/world.components.ts:101`                               |
| `_storeComponent` auto-removes conflicting exclusive components                                                                              | `entity.components.ts:402-426`                                             |
| Decorator import: `import { type as wireType } from "@vworlds/vecs-wire"`                                                                    | `lib/vecs-wire/src/index.ts:2`                                             |
| Wire scalar types: `bool,u8,i8,u16,i16,u32,i32,u64,i64,enum,f32,f64,string,bytes,any`; arrays `["f32"]`; nested classes                      | `lib/vecs-wire/src/decorators.ts`                                          |
| Default client interpolation blends network component **type 1** as 2D `{x,y}`; others snapped; configurable via `interpolators`             | `lib/vecs-client/src/client_world.ts` (`ClientWorldOptions.interpolators`) |
| `Relationship.target` is an `Entity` (not serializable); `Encoder.write` throws without `wireEncode` → relationships are **not** networkable | `lib/vecs/src/component_meta.ts:11-13`, `lib/vecs-wire/src/encoder.ts:271` |
| vecs-physics pose: `Position {x,y}` (meters), `Rotation {angle}` (radians)                                                                   | `lib/vecs-physics/src/components/body.ts`                                  |
| System/query API: `.with().enter().update().exit().each().run().phase()`                                                                     | `lib/vecs/src/system.ts`, `lib/vecs/src/query/query.ts`                    |

---

## 3. Locked design decisions

1. **No scenes in MVP.** One configured Phaser scene. Drop `Scene`/`InScene` and all
   relationship networking (relationships are not wire-encodable). Multi-scene is post-MVP.
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
        │  components + protocol arrays + TextAlign           no phaser/client/server
        ▼
@vworlds/vecs-phaser-client     (render module) deps: vecs-phaser, vecs-client
        │  PhaserRenderModule, VGameObject, CoordSpace       peer: phaser@^4.1
        ▼
@vworlds/vecs-phaser-server     (helpers, optional)  deps: vecs-phaser, vecs-server
           setExclusiveComponents wiring, builders, pose-sync  no phaser
```

### 5.1 Public API surface (the contract subagents build to)

**`@vworlds/vecs-phaser`**

```ts
// components (see §6)
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
export class Ellipse {
  /*…*/
}
export class Rectangle {
  /*…*/
}
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
export class Text {
  /*…*/
}
export enum TextAlign {
  Left = 0,
  Center = 1,
  Right = 2,
}
export const phaserNetworkComponents: readonly ComponentClass[]; // ORDER IS PROTOCOL
export const phaserRenderableComponents: readonly ComponentClass[];
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
}
export class VGameObject {
  obj: Phaser.GameObjects.GameObject;
}
export class PhaserRenderModule extends Module<PhaserRenderModuleConfig> {
  init(config: PhaserRenderModuleConfig): void;
}
export function phaserInterpolators(options?): Array<readonly [number, ComponentInterpolator]>;
export const rotationInterpolator: ComponentInterpolator;
```

**`@vworlds/vecs-phaser-server`** (optional)

```ts
export function registerRenderExclusivity(world: ServerWorld): void; // setExclusiveComponents(...renderables)
export function createArc(world, props): Entity; // + sibling shape builders
// …builders add Networked + the one renderable + provided transform/style
export function syncPhysicsPose(world: ServerWorld, options?): void; // physics Position/Rotation → render
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
] as const;
```

| Component     | Fields (wire type)                                                                                                                                           | Units / notes                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `Position`    | `x:f32=0`, `y:f32=0`                                                                                                                                         | meters, +y up. **Type 1 → free interpolation.** |
| `Rotation`    | `angle:f32=0`                                                                                                                                                | radians, CCW+. Frontier `rot()` negates.        |
| `Scale`       | `x:f32=1`, `y:f32=1`                                                                                                                                         | unitless multiplier                             |
| `Alpha`       | `value:f32=1`                                                                                                                                                | 0..1                                            |
| `Depth`       | `value:i32=0`                                                                                                                                                | render order (unitless)                         |
| `FillStyle`   | `color:u32=0xffffff`, `alpha:f32=1`                                                                                                                          | RGB int                                         |
| `StrokeStyle` | `color:u32=0xffffff`, `alpha:f32=1`, `width:f32=1`                                                                                                           | width in **screen px**                          |
| `Arc`         | `radius:f32=0.5`, `startAngle:f32=0`, `endAngle:f32=2π`, `anticlockwise:bool=false`, `iterations:f32=0.01`                                                   | radius meters; angles radians                   |
| `Ellipse`     | `width:f32=2`, `height:f32=1`                                                                                                                                | meters                                          |
| `Rectangle`   | `width:f32=2`, `height:f32=1`                                                                                                                                | meters                                          |
| `Polygon`     | `points:["f32"]=[]`                                                                                                                                          | alternating x,y meters (relative)               |
| `Line`        | `x1,y1,x2,y2:f32=0`                                                                                                                                          | meters (relative)                               |
| `Triangle`    | `x1,y1,x2,y2,x3,y3:f32`                                                                                                                                      | meters (relative)                               |
| `Star`        | `points:u8=5`, `innerRadius:f32=0.5`, `outerRadius:f32=1`                                                                                                    | radii meters                                    |
| `Text`        | `value:string=""`, `fontFamily:string="sans-serif"`, `fontSize:u16=16`, `color:u32=0xffffff`, `backgroundColor:u32=0`, `backgroundAlpha:f32=0`, `align:u8=0` | fontSize in **screen px**; `align`→`TextAlign`  |

Exactly one renderable per entity is enforced by `setExclusiveComponents(...phaserRenderableComponents)`
when the server package is used; the client also defensively prefers the first present
in `phaserRenderableComponents` order.

---

## 7. Client render module architecture

### 7.1 Data flow

```
ServerWorld (meters)                         ClientWorld (meters)            Phaser (pixels)
  entity.set(Arc/Position/…)                    progress(now, delta)
        │ collect snapshots (order §6)              │ apply() → decode → entity.attach()
        ▼ encode (f32)                              ▼ fires query enter/modified/exit
  StateDiff ── dgram ──────────────────────▶  PhaserRenderModule systems
                                                   │ new:    scene.add.*() + set VGameObject
                                                   │ sync:   setPosition/…  ── CoordSpace ──▶ mutate
                                                   └ exit:   remove VGameObject → destroy()
```

The app drives `clientWorld.progress(now, delta)` each frame (from the Phaser scene's
`update` or rAF). `apply()` runs in phase `ON_LOAD`; render systems observe the routed
events. Position is interpolated by the `DiffBuffer` _before_ `CoordSpace`, so motion is
smooth between server ticks.

### 7.2 Lifecycle & the enter-initialization invariant

State: local `VGameObject` component on each rendered entity. It is not networked and has no
`@wireType` fields. Looking up an object is `entity.get(VGameObject)?.obj`.

**Two systems per renderable**:

- `phaser.new.*` matches `.with(Shape).without(VGameObject)` and creates the GameObject via
  `scene.add.<kind>(…)`, then sets `VGameObject` on the entity.
- `phaser.render.*` matches `.with(Shape, VGameObject)`, mutates shape geometry on updates,
  and removes `VGameObject` on exit. `VGameObject.onRemove` destroys the Phaser object, so
  explicit entity destruction and `clearAllEntities()` also tear down immediately.

The render/exit systems are registered before creation systems so a same-frame renderable
type change can remove the old `VGameObject` before the new shape's `.without(VGameObject)`
creation query runs. Sync systems still run after creation, preserving same-tick initial
position/style.

**Shared transform/style sync systems** match `.with(Component, VGameObject)` for `Position`,
`Rotation`, `Scale`, `Alpha`, `Depth`, `FillStyle`, and `StrokeStyle`. Each has both `enter`
and `update`, so pre-present transform/style components initialize the GameObject in the same
tick that creation sets `VGameObject`. Initial sync is query-driven rather than manual.

Renderable **type change** (e.g. `Arc`→`Rectangle`): exclusivity removes the old renderable
→ old render system `.exit` removes `VGameObject`; its remove hook destroys the old object;
the new shape's creation system creates the replacement.

### 7.3 Reset

Baseline reset or disconnect destroys/clears networked entities → `VGameObject` is removed →
the remove hook destroys GameObjects. Reconnect builds a fresh `ClientWorld` and registers
`PhaserRenderModule` again. No separate reset handler or entity-id object registry is needed.

### 7.4 Interpolation

`Position` (type 1) is smoothed by default. Rotation interpolation is configured at
`ClientWorld.connectDgram` time by passing `phaserInterpolators()`, which adds a `Rotation`
type-id interpolator doing **shortest-arc angular lerp** in radians. It is not a render module
option. All other components snap to latest.

### 7.5 Origin & rotation pivot

`Position` is the **entity origin** — it maps to the Box2D body transform that
`syncPhysicsPose` copies, and it is the **rotation pivot** for every shape (`Rotation`
rotates about it, matching Box2D bodies). The renderer must guarantee this uniformly:

- **Centered primitives** (`Arc`, `Ellipse`, `Rectangle`, `Star`): Phaser already centers
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

---

## 8. Server-side usage (pure ECS)

```ts
import { ServerWorld } from "@vworlds/vecs-server";
import {
  phaserNetworkComponents,
  phaserRenderableComponents,
  Arc,
  Position,
  FillStyle,
} from "@vworlds/vecs-phaser";

const world = new ServerWorld({ name: "main", networkComponents: phaserNetworkComponents });
world.setExclusiveComponents(...phaserRenderableComponents);

world
  .entity()
  .add(Networked)
  .set(Arc, { radius: 0.25 }) // meters
  .set(Position, { x: 1.5, y: 1.0 }) // meters, +y up
  .set(FillStyle, { color: 0xffcc00, alpha: 1 });
```

Optional helpers in `@vworlds/vecs-phaser-server`:

- `registerRenderExclusivity(world)` — one call wrapping `setExclusiveComponents`.
- shape builders (`createArc`, `createRectangle`, …) that add `Networked` + the renderable.
- `syncPhysicsPose(world)` — system copying vecs-physics `Position`/`Rotation` (meters) →
  render `Position`/`Rotation`; a trivial copy since both are meters.

---

## 9. Demo migration (`apps/server` + `apps/client`)

The existing demo (canvas-2D balls/players + 3×3 interest-management grid, server already
physics-driven in meters) is migrated to prove the whole stack end to end.

### Target world model

- World in **meters, origin center, +y up**. Canvas 960×540, **PPM = 100** (matches the
  demo's current `PIXELS_PER_METER`). World extent ≈ x∈[−4.8,4.8], y∈[−2.7,2.7].
- `networkComponents = phaserNetworkComponents` **only**. Game-logic markers (`Ball`,
  `Player`) stay **server-local** (registered, not networked) → the client carries _zero_
  game components and renders purely from render components.

### Server changes (`apps/server/src/main.ts`)

- Replace bespoke `Position(i16)`/`Ball`/`Color` networked components with
  `phaserNetworkComponents`; keep `Ball`/`Player` as local components.
- Recenter all game math to meters/center-origin (walls, player spawn/movement, grid cells,
  collision). Physics already meters — drop the pixel `SyncPhysicsBalls` conversion; render
  `Position`/`Rotation` become a **direct copy** of physics pose (use `syncPhysicsPose`).
- Render mapping: **Ball** → `Arc` (radius = physics circle radius) + `FillStyle` (random);
  **Player** → `Rectangle` + `FillStyle`; **score** → a child `Text` entity following the
  player (server writes `Text.value = String(score)`).
- Add a few **static decorative entities** to exercise every renderable: `Star`, `Triangle`,
  `Polygon`, `Ellipse`, `Line`, with `FillStyle`/`StrokeStyle`.
- Keep interest management (`View` DSL, `InCell`, cell tags, `viewAll`) — now in meters.

### Client changes (`apps/client/src/main.ts` + `index.html`)

- Replace canvas-2D with a **Phaser.Game** (one `Scene`, 960×540).
- In `create()`: connect `ClientWorld.connectDgram({ networkComponents: phaserNetworkComponents, interpolators: phaserInterpolators(), … })`,
  then `world.module(PhaserRenderModule, { scene, pixelsPerMeter: 100 })`.
- In `update(time, delta)`: `world.setInput({arrows, viewAll})` then `world.progress(time, delta)`.
- **Delete the manual render systems.** Keep input (arrows + `G`). Cosmetic grid + the
  instructions line drawn with Phaser `Graphics`/`Text` in the demo scene (client-only).
- On disconnect, call `world.clearAllEntities()`; reconnect creates a fresh `ClientWorld` and
  registers the render module again.

### Demonstrates

auto-render from components, interpolation (moving balls), rotation (spinning physics balls),
Text (scores), all primitive shapes, lifecycle create/destroy as entities enter/leave the
view (interest management), and baseline-reset rebuild.

---

## 10. Testing strategy

- **`vecs-phaser`:** per-component wire round-trip (incl. `Polygon` array, `Text` strings,
  `TextAlign`); `phaserNetworkComponents` order snapshot; `phaserRenderableComponents`
  membership == primary renderables.
- **`vecs-phaser-client`:** `CoordSpace` math ((0,0)→center, (1,0)→+PPM, (0,1)→−PPM, angle
  negation, relative vs absolute). With **mock Phaser** objects (node env, no browser): load
  `PhaserRenderModule` on a `ClientWorld`; create on shape enter; initialize pre-present
  Position/FillStyle through sync-system ordering; transform/style updates apply via
  CoordSpace; destroy on exit/entity clear; recreate on renderable-type change; Text origin
  centered; vertex shapes pin `(0,0)` to `Position`.
- **`vecs-phaser-server`:** exclusivity rejects two renderables; builders add `Networked` +
  intended renderable; `syncPhysicsPose` copies pose.
- **Demo:** manual + scripted end-to-end (see [`TICKETS.md`](./TICKETS.md) VPH-42).
- Repo gates: `npm run test|typecheck|lint|format` across workspaces.

---

## 11. Risks & mitigations

| Risk                                                                          | Mitigation                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Frontier conversion (centering, Y-flip, angle negation, relative vs absolute) | Localized in `CoordSpace`; exhaustive unit tests + visual demo check                                                    |
| Component order is protocol **and** enter-init invariant                      | Snapshot test the order; document in code                                                                               |
| New adds after a shape's enter aren't routed to `.update`                     | Enter reads all present components; order guarantees they're there                                                      |
| Vertex-shape origin (Phaser anchors on bounding box, not vertex `(0,0)`)      | Pin vertex `(0,0)` to `Position` & rotation pivot per §7.5; handle asymmetric/negative points                           |
| `Polygon.setTo` rebuilds geometry                                             | Treat as definition data, not per-frame                                                                                 |
| Interpolation cadence (smoothness)                                            | Verify `.update(Position)` fires per frame during interp (existing demo behavior)                                       |
| `phaser` version/peering                                                      | `phaser` is a **type-only peer dep** of the client lib; the app provides the runtime; `CoordSpace` avoids `Phaser.Math` |

---

## 12. Success criteria

- Server creates entities with shape/text components **in meters**; client auto-renders them
  in Phaser with **no per-entity-type render code**.
- Origin-at-center, +y-up meters (server) ↔ y-down pixels (client) is correct and lives only
  at the Phaser frontier.
- `Position`/`Rotation` align with `vecs-physics`; pose-sync is a plain copy.
- `View`/`EntityTracker` remains the only visibility mechanism.
- Baseline reset fully rebuilds GameObjects; works with no image assets.
- Migrated demo renders balls/players/scores/decoration end to end with interest management.
