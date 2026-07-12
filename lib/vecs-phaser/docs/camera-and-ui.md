# Camera & screen-space UI

Server-driven cameras and HUDs. The server controls each client's viewport
by setting components on that client's **session entity**, and builds HUDs
out of ordinary networked entities pinned to the screen.

## The session entity

Every connection gets a server-side session entity (the one carrying
`NetworkClient`/`View`/`NetworkInput`). It is `Networked`, so when your view
DSL includes it, its components replicate like any other entity. The client
learns _which_ entity is its own session through a built-in RPC:
`ClientWorld.sessionEntity()` (used automatically by `CameraModule`). Each
client obeys only its own session's camera components — other players'
session entities may be in view and are ignored.

> Include session entities in the view DSL (simplest: `View { dsl: true }`)
> or the camera components never arrive. See [Networking](./networking.md).

## Camera components

```ts
// Server, when a player spawns:
session
  .set(CameraFollow, { target: tank, lerp: 0.15 }) // ease toward the tank
  .set(CameraBounds, { x: -12.5, y: -7.5, width: 25, height: 15 })
  .set(CameraZoom, { value: 1 });

// On a hit:
victimSession.set(CameraShake, { duration: 0.4, intensity: 0.02 });
```

```ts
// Client, once:
world.module(CameraModule, { scene, pixelsPerMeter: 100 });
```

| Component      | Behavior                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CameraFollow` | Centers on the target's interpolated `Position` each frame; `lerp` = fraction of remaining distance per tick (1 = locked). Retarget freely (kill cams, spectating).     |
| `CameraZoom`   | Zoom multiplier; removal resets to 1.                                                                                                                                   |
| `CameraBounds` | Scroll limits — bottom-left-anchored rect in meters (math convention); removal lifts them.                                                                              |
| `CameraShake`  | Fires on every **set**. Short one-shot; a baseline resend replays the latest set, so either keep `duration` short or remove the component a few ticks after setting it. |

This is what makes worlds **larger than the screen** work: each player sees
their own scrolling window onto one shared arena, with zero camera code in
the game client.

## `ScreenAnchor`: replicated HUD

`ScreenAnchor` replaces `Position` (they are mutually exclusive): the entity
renders in **screen space**, pinned to the camera (scroll factor 0), and
re-laid out when the canvas resizes.

```ts
// Top-center title:
world
  .entity()
  .add(Networked)
  .set(Text, { value: "TANK ARENA", fontSize: 14 })
  .set(ScreenAnchor, { x: 0.5, y: 1, offsetY: -0.25 });

// Top-left scoreboard row, one line per player:
world
  .entity()
  .childOf(player)
  .add(Networked)
  .set(Text, { value: "GREEN 0", fontSize: 14 })
  .set(ScreenAnchor, { x: 0, y: 1, offsetX: 0.25, offsetY: -0.4 - index * 0.22 });
```

`x`/`y` are normalized screen fractions in math convention (`0,0` =
bottom-left, `1,1` = top-right); offsets nudge in meters. Because HUD
elements are ordinary entities, they update reactively (set `Text` when a
score changes), clean up with their owner (`childOf`), and need **no client
UI code**. Pair with [`Origin`](#per-object-anchors) for text alignment.

## Per-object anchors and toggles

- **`Origin { x, y }`** — normalized anchor for `Image`/`Sprite`/`Text`
  (math convention: `y = 0` anchors the bottom). `{ x: 0.5, y: 0 }` plants a
  character's feet on its `Position`; `{ x: 0, y: 1 }` top-left-aligns a
  label. Default `(0.5, 0.5)` = centered, like every other renderable.
- **`Hidden`** _(tag)_ — present = not rendered. Toggle visibility without
  destroying (respawn phases, blinking, fog of war).
- **`Flip { x, y }`** — mirror textured renderables/text; shapes mirror with
  a negative `Scale` instead.
