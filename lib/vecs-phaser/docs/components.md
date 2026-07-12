# Components

The protocol reference: every networked component in `@vworlds/vecs-phaser`,
its wire id, fields, and units. Source:
[`lib/vecs-phaser/src`](../src/index.ts).

Conventions that apply everywhere:

- **Meters, +y up, radians CCW-positive** ("math convention"). Pixels exist
  only inside the client's `CoordSpace` (see [Rendering](./rendering.md)).
- **The order of `phaserNetworkComponents` is the wire protocol** (wire type
  id = index + 1). New components are appended, never inserted; a snapshot
  test pins the order.
- Exactly **one renderable per entity** (`phaserRenderableComponents` is an
  exclusive set, enforced by `PhaserServerModule`).

## Transform & display state

| Id  | Component      | Fields                                         | Notes                                                                                           |
| --- | -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | `Position`     | `x, y: f32`                                    | Meters, +y up. Interpolated when `phaserInterpolators()` is installed.                          |
| 2   | `Rotation`     | `angle: f32`                                   | Radians CCW+. The client negates at the frontier (y-flip inverts handedness).                   |
| 3   | `Scale`        | `x, y: f32 = 1`                                | Unitless multiplier.                                                                            |
| 4   | `Alpha`        | `value: f32 = 1`                               | 0..1.                                                                                           |
| 5   | `Depth`        | `value: i32 = 0`                               | Render order; higher draws on top.                                                              |
| 23  | `Hidden`       | _(tag)_                                        | Presence hides the GameObject; removal shows it. Zero wire bytes.                               |
| 24  | `Flip`         | `x, y: bool`                                   | Mirroring for `Image`/`Sprite`/`Text` only; shapes mirror with negative `Scale`.                |
| 25  | `Origin`       | `x, y: f32 = 0.5`                              | Normalized anchor, math convention (`y = 0` = bottom). `Image`/`Sprite`/`Text` only.            |
| 26  | `ScreenAnchor` | `x, y: f32 = 0.5`, `offsetX, offsetY: f32 = 0` | Screen-space placement (HUD); exclusive with `Position`. See [Camera & UI](./camera-and-ui.md). |

## Style

| Id  | Component     | Fields                                       | Notes                                                            |
| --- | ------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| 6   | `FillStyle`   | `color: u32 = 0xffffff`, `alpha: f32 = 1`    | Shapes only.                                                     |
| 7   | `StrokeStyle` | `color: u32`, `alpha: f32`, `width: f32 = 1` | `width` in **screen pixels** (crisp lines at any zoom).          |
| 18  | `Tint`        | four corner `u32`s + `monochromatic: bool`   | `Image`/`Sprite`/`Text` only; `value` setter writes all corners. |

## Renderables (one per entity)

| Id  | Component   | Fields                                                               | Notes                                                                            |
| --- | ----------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 8   | `Arc`       | `radius`, `startAngle`, `endAngle`, `anticlockwise`, `iterations`    | Angles radians CCW+.                                                             |
| 9   | `Ellipse`   | _(tag)_                                                              | Sized by `Size`.                                                                 |
| 10  | `Rectangle` | _(tag)_                                                              | Sized by `Size`.                                                                 |
| 11  | `Polygon`   | `points: f32[]`                                                      | Alternating x,y meters, relative to `Position`.                                  |
| 12  | `Line`      | `x1, y1, x2, y2: f32`                                                | Relative meters.                                                                 |
| 13  | `Triangle`  | `x1..y3: f32`                                                        | Relative meters.                                                                 |
| 14  | `Star`      | `points: u8 = 5`, `innerRadius`, `outerRadius: f32`                  | Radii meters.                                                                    |
| 15  | `Text`      | `value`, `fontFamily`, `fontSize: u16`, `color`, background, `align` | `fontSize` in **screen pixels**; origin centered by default.                     |
| 17  | `Image`     | `texture: u32`, `frame: u16`                                         | Catalog resource id + frame. See [Assets](./assets.md).                          |
| 20  | `Container` | _(tag)_                                                              | Renders as a Phaser Container for native parenting.                              |
| 31  | `Sprite`    | `texture: u32`, `frame: u16`                                         | Like `Image` but can play animations. See [Sprites](./sprites-and-animation.md). |

`Size` (16, `width/height: f32` meters) sizes `Ellipse`/`Rectangle` via
`setSize` and `Image`/`Sprite` via `setDisplaySize`; without it, textured
renderables keep their native pixel size ÷ PPM.

## Parenting (see [Parenting](./parenting.md))

| Id  | Component | Fields       | Notes                                                                    |
| --- | --------- | ------------ | ------------------------------------------------------------------------ |
| 19  | `DrawIn`  | relationship | Child of the target's Phaser `Container` (native transform composition). |
| 21  | `Offset`  | `x, y: f32`  | Local position inside/relative to the display parent.                    |
| 22  | `DrawBy`  | relationship | Computed parenting: world `Position` derived from the target's.          |

## Camera (session entity; see [Camera & UI](./camera-and-ui.md))

| Id  | Component      | Fields                                   | Notes                                                   |
| --- | -------------- | ---------------------------------------- | ------------------------------------------------------- |
| 27  | `CameraFollow` | relationship + `lerp: f32 = 1`           | Camera tracks the target; `lerp` eases the chase.       |
| 28  | `CameraZoom`   | `value: f32 = 1`                         | Reset to 1 on removal.                                  |
| 29  | `CameraBounds` | `x, y, width, height: f32`               | Bottom-left-anchored rect in meters; lifted on removal. |
| 30  | `CameraShake`  | `duration: f32 = 0.25`, `intensity: f32` | One-shot per **set**.                                   |

## Media & effects

| Id  | Component       | Fields                                                                          | Notes                                                                      |
| --- | --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 32  | `Animation`     | `tile: u16`, `speed: f32 = 1`                                                   | Presence plays the tileset animation on a `Sprite`.                        |
| 33  | `Sound`         | `asset: u32`, `volume: f32 = 1`, `rate: f32 = 1`                                | One-shot per set. See [Audio](./audio.md).                                 |
| 34  | `Music`         | `asset: u32`, `volume: f32 = 1`, `loop: bool = true`                            | Plays while present.                                                       |
| 35  | `ParticleBurst` | `texture`, `frame`, `count`, `speed`, `lifespanMs`, `scale`, `gravityY`, `tint` | One burst per set at the entity's `Position`. See [Effects](./effects.md). |

## Not networked (but part of the toolkit)

- `InputPayload` / `actionMask` / `hasAction` — the input contract, sent via
  `setInput`, never as a component ([Input](./input.md)).
- Server-local: `PlayerInput`, `Lifetime` (`@vworlds/vecs-phaser-server`).
- Client-local: `LocalInput`, `MusicPlayback` (`@vworlds/vecs-phaser-client`).
