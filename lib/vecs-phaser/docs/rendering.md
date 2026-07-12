# Rendering

How `PhaserRenderModule` turns replicated components into live Phaser
GameObjects — the coordinate model, the GameObject-as-component lifecycle,
and the interface markers that keep the whole renderer polymorphic.

## Coordinate model: meters in, pixels at the frontier

Every component field is in **meters, +y up, radians CCW-positive**, on both
server and client. Pixels appear only when the render systems call Phaser
setters, through `CoordSpace`
([`src/coord_space.ts`](../../vecs-phaser-client/src/coord_space.ts)),
parameterized by `pixelsPerMeter` (default 64):

```
x(mx)  = width/2  + ppm·mx        // origin at canvas center
y(my)  = height/2 − ppm·my        // Y flip
len(m) = ppm·m                    // radii, sizes
rot(r) = −r                       // Y flip inverts handedness
mx(px), my(py)                    // inverses (pointer → meters)
```

Because the Y axis flips, a math-positive rotation must render as `−angle`,
and `Origin`/`ScreenAnchor`/`CameraBounds` all interpret their y values in
math convention and convert at the frontier.

## The GameObject _is_ the component

There is no `eid → object` map. When a renderable component arrives (say
`Arc`), a creation system builds the Phaser object and **attaches the live
object to the entity as a component**, keyed by its concrete class:

```ts
world
  .system("phaser.new.arc")
  .with(Arc)
  .without(Phaser.GameObjects.Arc)
  .phase(ON_STORE)
  .enter([Arc], (entity, [arc]) => {
    entity.attach(new Phaser.GameObjects.Arc(scene, 0, 0, coords.len(arc.radius)));
  });
```

From then on the entity's component set _is_ the render lifecycle:

- **Update**: geometry systems watch the data component and mutate the
  attached object (`update({ watch: Arc, inject: [m.Arc] })`).
- **Teardown**: one hook — `component(m.GameObject).onRemove((_e, obj) =>
obj.destroy())` — fires whenever the attached object leaves an entity, for
  any reason: explicit removal, renderable type swap, entity destruction, or
  a baseline reset (`clearAllEntities()`).
- **Type swap**: renderables are mutually exclusive, so `entity.set(Rectangle)`
  on an `Arc` entity auto-removes `Arc` → its remove hook drops the attached
  Arc object → destroyed → the Rectangle creation system rebinds. No
  special-casing anywhere.

## Interface markers: one sync system drives every renderable

Systems never query concrete Phaser classes. `markers.ts` declares abstract
marker classes whose methods mirror the Phaser API the renderer calls
(`Transform`, `Alpha`, `Depth`, `Fill`, `Stroke`, `Size`, `Visible`, `Flip`,
`Origin`, `Tint`, `Texture`, `Animated`, geometry markers), and each concrete
Phaser class declares what it implements:

```ts
world.component(Phaser.GameObjects.Sprite).set(Implements, {
  interfaces: [
    m.GameObject,
    m.Transform,
    m.Alpha,
    m.Depth,
    m.Texture,
    m.Tint,
    m.Visible,
    m.Flip,
    m.Origin,
    m.Animated,
  ],
});
```

A query on a marker matches any entity whose attached GameObject implements
it, and injects the object typed to the marker's setters. That is how one
`phaser.sync.position` system positions arcs, sprites, text, and containers
alike — and why a data component on an unsupported renderable (e.g. `Flip`
on a primitive shape) is a **silent no-op by design**: the marker simply
doesn't match.

## Phases and the same-tick init invariant

`ClientWorld.apply()` runs in `ON_LOAD`; every render system runs in
`ON_STORE`. Within `ON_STORE`, creation systems are registered before the
shared sync systems, and sync callbacks use `update({ onEnter: true })` — so
an entity that arrives with `Position` + `FillStyle` + `Arc` is created _and_
fully initialized in the same tick, purely query-driven.

## Module map (`@vworlds/vecs-phaser-client`)

| Module                               | Responsibility                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `PhaserRenderModule`                 | Umbrella: markers, `Implements` declarations, loads everything below in order.         |
| per-shape modules (`ArcModule`, …)   | Creation + geometry systems + the shape-data remove hook, one per renderable.          |
| `DisplaySetupModule`/`DisplayModule` | Display-list placement and the `DrawIn`/`DrawBy` policy ([Parenting](./parenting.md)). |
| `ScreenAnchorModule`                 | Screen-space HUD placement ([Camera & UI](./camera-and-ui.md)).                        |
| `SyncModule`                         | Shared transform/style/visibility syncs through the markers.                           |

Registered separately (each optional): `CameraModule`, `AudioModule`,
`EffectsModule`, `InputCaptureModule`.

## Testing

The whole renderer is testable headless: the test suite aliases `phaser` to
a recording stub
([`tests/phaser_stub.ts`](../../vecs-phaser-client/tests/phaser_stub.ts)) and
asserts on recorded setter calls. Follow that pattern for game-side render
tests.
