# vecs-phaser design guide

How to build a **simple, fun 2D multiplayer game** on this stack — the
opinions, the load-bearing patterns, and the mistakes to skip. This layers
on top of the ECS rules in
[`lib/vecs/docs/design-guide.md`](../../vecs/docs/design-guide.md) (read its
§1–§2 first: components are data, systems are behavior, lifecycle is
component presence); everything there applies to game code too. The worked
example throughout is the
[Tank Arena demo](../../../apps/demo-server/README.md).

---

## 1. The shape of a game

**The server is the game. The client is a lens.**

- The server owns every entity, runs all gameplay in phased systems at a
  fixed tick, and _describes_ the world with small render components in
  meters.
- The client loads assets, connects, registers the four client modules
  (render, camera, audio, effects) plus input capture, and calls
  `world.progress()` per frame. A finished client is ~150 lines — the Tank
  Arena's [`main.ts`](../../../apps/demo-client/src/main.ts) — and contains
  **zero gameplay and zero per-entity render code**.

If you find yourself writing client code that knows what a "tank" is, stop:
either it belongs on the server, or it is cosmetic and belongs in a
component the client already knows how to expand.

Structure the server as **feature modules** (vecs design guide §6): one
folder per cohesive feature with `module.ts` + `components.ts`, composed by
one umbrella module in dependency order. Tank Arena: `assets → arena →
tanks → shells → hud`.

## 2. Thin wire: compose on the server, expand on the client

The wire is the scarce resource. Two complementary tools keep it thin:

**Compose on the server** when the parts are individually authoritative.
A compound visual (hull + turret), a score label over a head — build them as
entities with `DrawIn`/`DrawBy` + `Offset` ([Parenting](./parenting.md)).
Rotating one parent `Container` costs one f32 per tick no matter how many
children ride along.

**Expand on the client** when the detail is cosmetic and derived. Send one
small component; let a client module unfold it locally:

| One component on the wire | The client expands it into         |
| ------------------------- | ---------------------------------- |
| `ParticleBurst`           | dozens of local particles          |
| `Animation { tile }`      | a frame-by-frame tileset animation |
| `Sound` / `Music`         | decoded, mixed audio               |
| `CameraShake`             | a screen-space shake curve         |

The dividing line: **replicate what is authoritative and interactable;
expand what is cosmetic and derived.** Shells are entities (they bounce,
they kill); their explosion is a `ParticleBurst`. When a cosmetic pattern
recurs across games, that is a hint it wants to become a new component +
client module pair — that is exactly how the current set came to be.

A corollary for aggregates: for _simple_ things, server composition is
fine and clearer. Don't invent a `TankVisual` mega-component with client
expansion when two `DrawIn` children do the job readably.

## 3. Gameplay in ECS terms

- **State is presence.** Dead-but-respawning = `Hidden` + `Respawning` +
  `Body { enabled: false }` — three components, no `isDead` boolean, no
  state machine object. Track animation while driving = `Animation` present
  while moving. Systems gate on presence (`.without(Respawning)`).
- **One-shots are short-lived entities.** Explosion, muzzle sound, pickup
  sparkle: spawn an entity with the effect components + `Lifetime`, never
  touch it again ([Effects](./effects.md)).
- **Ownership is `ChildOf`.** Tank `childOf` session, collider `childOf`
  tank, scoreboard row `childOf` tank: a disconnect destroys the whole tree
  with zero cleanup code. Keep display parenting (`DrawIn`/`DrawBy`) a
  separate concern.
- **React, don't scan.** Score display updates with `.update(Tank)`; shell
  impacts with `.update(ContactEvents)`. Reserve `.each` for genuinely
  continuous work (driving from held input, countdowns) — and let physics
  do the moving: set velocities, not positions.
- **Entity references in components are fine** (`Tank.session`,
  `Shell.shooter`) for server-local wiring; promote to a `Relationship` when
  you need queries/cascades/networking through it.

## 4. Input: authoritative and boring (that's good)

Define one ordered action list in a shared config; capture with
`InputCaptureModule`, decode with `InputDecodeModule`, and write gameplay
against the sanitized `PlayerInput` ([Input](./input.md)).

Design controls for a lossy latest-state channel with ~1 RTT of lag and no
prediction:

- **Velocity-style movement** (Tank Arena: turn rate + throttle along
  facing) hides latency far better than position-teleport controls.
- **Held actions with server cooldowns** beat edge-triggered taps: fire
  while held, gated by a cooldown, never "one bullet per keypress packet."
- Interpolate `Position`/`Rotation` (`phaserInterpolators()`) and keep tick
  rate modest (30 Hz is plenty for arcade play).
- Reliable discrete commands (ready-up, buy) go over RPC, not input.

## 5. Per-player experience lives on the session entity

The session entity is your per-player root: the server sets
`CameraFollow`/`CameraBounds`/`CameraZoom`/`CameraShake` on it
([Camera & UI](./camera-and-ui.md)), parents the player's avatar to it, and
can carry per-player replicated state. Each client resolves its own session
via the built-in handshake and obeys only that entity's camera. Personal
viewports over one shared world — kill cams and spectating are just
retargeting `CameraFollow`.

HUDs are replicated `ScreenAnchor` entities, updated reactively. No client
UI code until you genuinely need client-only chrome (menus, settings).

## 6. Make it feel good with data

Game feel is mostly server-side component writes: `CameraShake` on hits,
`ParticleBurst` + `Sound` on events, `Animation` state changes, `Tint` or
`Hidden` blinks on invulnerability. Because they are data, they replicate to
exactly the right audience through views, and they cost you no client code.

## 7. Interest management: start with everything, narrow later

`View { dsl: true }` for every session is correct for a screen-or-two arena.
Narrow to spatial views (cell tags + `InCell` + per-cell DSLs, as in the
original demo) only when entity counts or bandwidth say so — the render
layer already handles entities entering/leaving the view gracefully. Keep
session entities in every view.

## 8. Anti-patterns

| Smell                                               | Do instead                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Client code that knows game concepts ("if tank…")   | Server-side components the generic modules already render.                                        |
| Replicating per-particle / per-frame cosmetics      | One `ParticleBurst`/`Animation` component, expanded client-side.                                  |
| `isDead`/`state` fields + branching                 | Presence: `Hidden`, `Respawning`, `.without(...)` gates.                                          |
| Client-side gameplay ("it feels laggier otherwise") | Authoritative server + velocity controls + interpolation; prediction is a later, deliberate step. |
| Trusting input semantics                            | `InputDecodeModule` sanitizes shape; your systems enforce legality (cooldowns, ranges).           |
| Manual cleanup on disconnect/death                  | `ChildOf` cascades + `Lifetime` + component hooks.                                                |
| Inventing custom phases for game systems            | The built-in taxonomy: decode in `POST_LOAD`, gameplay in `ON_UPDATE`, impacts in `ON_VALIDATE`.  |
| Reordering `phaserNetworkComponents`                | Append-only, both ends together ([Networking](./networking.md)).                                  |

## 9. A build order that works

1. **Arena first**: static physics + walls, `View: true`, connect a client —
   you can see the world.
2. **Avatar + input**: spawn per connection, drive with `PlayerInput`,
   camera follow. Now it's a toy.
3. **The verb**: the one interaction your game is about (shoot, collect,
   paint). Contacts in `ON_VALIDATE`, consequences as component writes.
4. **Feel**: explosion entities, sounds, shake, animations — pure data.
5. **Score + HUD**: reactive `ScreenAnchor` rows.
6. Only then: interest management, more content, stretch systems.

Each step is playable. That is the point: with an authoritative ECS and a
generic client, a multiplayer game grows by _adding components and systems_,
not by threading new netcode.
