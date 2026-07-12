# Input

The input toolkit formalizes the client→server input channel into a typed,
sanitized pipeline. No new wire components — the payload rides the existing
`ClientWorld.setInput` → server `NetworkInput` slot, now with a shared shape.

## The shared contract

Both ends agree on an **ordered action list**; an action's bit index is its
index in that list. `@vworlds/vecs-phaser` exports the contract:

- `InputPayload` — the compact blob `{ a, px?, py?, pd? }` (action bitmask,
  pointer meters, pointer down).
- `actionMask(order, active)` / `hasAction(mask, order, name)`.

Define the order once per game and use it on both sides:

```ts
export const INPUT_ACTIONS = ["left", "right", "up", "down", "fire"] as const;
```

## Client: `InputCaptureModule`

```ts
world.module(InputCaptureModule, {
  scene,
  pixelsPerMeter: 100, // must match the render module
  actions: {
    left: ["A", "LEFT"], // action → Phaser key names; order = bit order!
    right: ["D", "RIGHT"],
    up: ["W", "UP"],
    down: ["S", "DOWN"],
    fire: ["SPACE"],
  },
});
```

Each tick (in `ON_LOAD`) it polls the bound keys through Phaser's keyboard
plugin (reconnect-safe: `addKey` caches by keycode), converts the pointer to
**world meters** (camera-aware — `pointer.worldX/Y` through the `CoordSpace`
inverses), calls `world.setInput(payload)`, and mirrors the same snapshot
into the client-local `LocalInput` world-global component:

```ts
const input = world.get(LocalInput); // { mask, pointerX, pointerY, pointerDown }
```

**Mobile** works out of the box: touch drives the pointer fields and keys
simply never press. Build a virtual joystick as client-local UI that writes
into the same action set — read `LocalInput` for rendering the stick, and
pass your synthesized actions through a custom capture if you need more than
pointer taps.

## Server: `InputDecodeModule` + `PlayerInput`

```ts
world.module(InputDecodeModule, { actions: [...INPUT_ACTIONS] });
```

A `POST_LOAD` reactive system decodes each session's raw `NetworkInput` blob
into the server-local **`PlayerInput`** component on the session entity —
sanitized: unknown action bits masked off, pointer values checked finite and
clamped (default ±1000 m), pointer-down coerced to a strict boolean. Game
systems read typed input and never touch raw blobs:

```ts
world
  .system("tanks.drive")
  .with(Tank, PhysicsRotation)
  .each([Tank, PhysicsRotation], (entity, [tank, rotation]) => {
    const input = tank.session.get(PlayerInput);
    if (!input) return;
    const turning = hasAction(input.mask, INPUT_ACTIONS, "left");
    // …
  });
```

## Semantics to design around

- The channel carries the **latest state**, not an event stream: a quick
  press between two sends can be missed, and packets are unordered/lossy.
  Edge-triggered actions (fire, jump) should be level-held client-side and
  cooldown-gated server-side (the Tank Arena fires while held, gated by a
  0.45 s cooldown) rather than single-tick pulses.
- For reliable discrete commands (buy, chat, ready-up), use RPC
  (`world.invoke`) instead of input — see [Networking](./networking.md).
- Never trust the blob: `InputDecodeModule` sanitizes shape, but _semantics_
  (rate limits, legality) are your systems' job.
