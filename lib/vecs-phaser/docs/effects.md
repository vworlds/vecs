# Effects

One-shot visual/audio flourishes as short-lived entities — the
**client-expansion pattern** in its purest form.

## `ParticleBurst`

One small component describes an explosion-style burst; the client expands
it into a local Phaser particle emitter at the entity's `Position`. Nothing
per-particle ever crosses the wire.

```ts
// Client, once:
world.module(EffectsModule, { scene, pixelsPerMeter: 100 });
```

```ts
// Server — a complete explosion, self-cleaning:
world
  .entity()
  .add(Networked)
  .set(Position, { x, y })
  .set(ParticleBurst, {
    texture: tiles.id,
    frame: SPARK,
    count: 26,
    speed: 3.5, // max speed in m/s (particles spread 50–100%)
    lifespanMs: 550,
    scale: 0.9, // start scale, shrinks to 0
    gravityY: 0, // m/s², math convention (negative = down)
    tint: 0xff8800,
  })
  .set(Sound, { asset: boom.id, volume: 0.9 })
  .set(Lifetime, { seconds: 1 });
```

The burst fires on every **set** (including entry); the client disposes the
emitter after the particles die. Entities without `Position` never fire.

## `Lifetime`: the one-shot driver (server)

`Lifetime { seconds }` (from `@vworlds/vecs-phaser-server`, install
`LifetimeModule`) is a server-local countdown that destroys the entity on
expiry. The removal replicates, and every client-side hook unwinds from it:
the emitter was already independent, the `Sound` played, a `Sprite`'s
GameObject is destroyed, `Music` stops. **Spawn → expire → everything cleans
itself up on both ends.**

Recipes:

| Effect            | Components on the effect entity                                        |
| ----------------- | ---------------------------------------------------------------------- |
| Explosion         | `Position` + `ParticleBurst` + `Sound` + `Lifetime(1)`                 |
| Animated fireball | `Position` + `Sprite` + `Animation` + `Size` + `Lifetime(anim length)` |
| Muzzle report     | `Sound` + `Lifetime(0.5)` (no position needed)                         |
| Pickup sparkle    | `Position` + `ParticleBurst{count: 8, speed: 1}` + `Lifetime(0.5)`     |

## Why not replicate particles?

Twenty-six particles at 30 Hz would be ~780 component updates/second _per
explosion per client_ — for fire-and-forget cosmetics no one can interact
with. The rule of thumb from the [design guide](./design-guide.md): replicate
what is **authoritative and interactable**; expand locally what is
**cosmetic and derived**. `ParticleBurst` (and `Animation`) sit on the
right side of that line.
