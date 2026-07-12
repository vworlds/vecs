# Sprites & animation

Animated, textured renderables driven entirely by data: Tiled authors the
animation, the server catalogs it, the client plays it.

## `Sprite` vs `Image`

Both render a catalog texture frame and share every transform/style sync.
`Image` is static; `Sprite` can additionally play tileset animations via the
`Animation` component. Prefer `Image` for props, `Sprite` for anything that
animates.

```ts
world.entity().add(Networked).set(Position, spawn).set(Sprite, { texture: ship.id, frame: 4 }); // static frame 4 until animated
```

## `Animation`: presence-driven playback

```ts
entity.set(Animation, { tile: 0, speed: 1 }); // play tileset animation of tile 0, looped
entity.set(Animation, { tile: 6 }); // switch animations (restarts)
entity.set(Animation, { tile: 6, speed: 2 }); // same tile: speed changes, no restart
entity.remove(Animation); // stop; Sprite.frame shows again
```

- `tile` is the Tiled tile id that owns the animation. The client registered
  it during `loadAssets` as the Phaser animation `"<textureId>:<tile>"`,
  with the exact per-frame durations authored in Tiled.
- Presence = playing (looped); removal = stopped. This is the ECS way: a
  respawning tank stops animating because the server removed the component,
  not because anyone called `stop()`.
- While an `Animation` is present it owns the displayed frame — static
  `Sprite.frame`/`texture` updates are deliberately ignored until it is
  removed.

## Authoring animations in Tiled

Add frames to a tile's animation in the Tiled tileset editor; the server
captures them at ingestion (`TilesetAsset.tile(id).animation`) and publishes
them in the catalog (`SpritesheetDescriptor.animations`). Nothing else to
wire up. The [Tank Arena tileset](../../../apps/demo-server/scripts/generate-assets.mjs)
authors track and explosion animations this way, in code.

## Patterns

- **State-driven animation**: toggle `Animation` from gameplay state — the
  Tank Arena adds it while the tank moves and removes it when idle
  (`tanks.drive` in
  [`apps/demo-server/src/game/modules/tanks/module.ts`](../../../apps/demo-server/src/game/modules/tanks/module.ts)).
- **One-shot flourishes**: an explosion is a short-lived entity with
  `Sprite` + `Animation` + a server `Lifetime` matching the animation length
  — it plays once and the entity (and its GameObject) vanish.
- **Variants by frame**: one tileset, many looks — `frame`/`tile` pick the
  color or variant, so four tank colors cost zero extra assets or protocol.
