# Networking

How the Phaser layer rides the vecs replication stack: what replicates and
to whom, smoothing, the session handshake, RPC, and the protocol rules that
keep old and new builds compatible.

The transport/replication machinery itself lives in `@vworlds/vecs-server` /
`@vworlds/vecs-client` (state diffs over an unordered WebRTC datachannel,
per-client baselines and acks); this guide covers what a vecs-phaser game
needs to know.

## What replicates: `Networked` + `View`

Only entities with `Networked` replicate, and each client receives exactly
the entities matched by its session's `View.dsl` (a query DSL). The default
is `false` — clients see **nothing** until you set a view:

```ts
// Simplest: everyone sees everything (fine for small arenas):
world.component(NetworkClient).onSet((entity) => entity.set(View, { dsl: true }));
```

For big worlds, give each client a narrower DSL and retarget it as they move
— the original demo's 3×3 grid interest management
([`apps/server/src/demo/modules/spatial-interest`](../../../apps/server/src/demo/modules/spatial-interest/module.ts))
is the reference: cell tag components + `InCell` relationship + per-cell
DSLs, swapped on the session's `View`. Entities leaving the view are
destroyed client-side (their GameObjects unwind through the normal hooks);
entities entering arrive as full snapshots.

> Session entities carry the camera components — make sure your DSL includes
> them (`dsl: true` does).

## Smoothing: opt-in interpolation

The server ticks at ~30 Hz; the client renders at 60+. Pass
`interpolators: phaserInterpolators()` at connect time to interpolate
`Position` (linear) and `Rotation` (shortest-arc) between server frames.
Everything else snaps. There is no client-side prediction: input is applied
authoritatively on the server, so your own tank reacts one round-trip later
— design controls that feel good under that (velocity-style movement, short
cooldowns) rather than twitch-teleport mechanics.

## The session handshake

`ClientWorld.sessionEntity()` resolves (and caches) the entity representing
this client's session, via a built-in system RPC answered by every
`ServerWorld` connection. `CameraModule` uses it automatically; game code
can use it to find "my" replicated session state (scores, loadouts) the
server put on the session entity.

## RPC vs input

Two client→server channels, use each for what it is:

| Channel                         | Guarantees                            | Use for                                            |
| ------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `setInput` → `PlayerInput`      | Latest-state, lossy, every tick       | Continuous controls ([Input](./input.md)).         |
| `invoke(rpcId, params)` (≥ 101) | Request/response, retried, idempotent | Discrete reliable commands (join team, buy, chat). |

RPC ids 1–100 are reserved for the suite (id 1 = session handshake).

## Protocol rules (breaking things is easy — don't)

- `phaserNetworkComponents` **order is the protocol**: wire id = index + 1.
  Append only; never insert, reorder, or change fields of shipped
  components. The order snapshot test
  ([`tests/protocol.test.ts`](../tests/protocol.test.ts)) must be updated in
  the same change as any append.
- Custom game components can be networked too: pass your own array
  `[...phaserNetworkComponents, MyComponent]` on **both ends** — same order,
  same classes, fields marked with `@wireType`.
- Server-only game logic components (markers, timers) are simply _not_ in
  the array — registered, used, never sent. That keeps the client generic:
  the Tank Arena client never learns what a "Tank" is.
- Baseline resends replay the **latest** state of living components. One-shot
  semantics (`CameraShake`, `Sound` on a long-lived entity) therefore replay
  for late joiners — prefer short-lived effect entities
  ([Effects](./effects.md)).

## Reset & reconnect

A disconnect (or server restart) triggers a baseline reset: all `Networked`
entities are destroyed client-side and rebuilt from a fresh snapshot. Every
vecs-phaser module unwinds through component hooks (GameObjects destroyed,
music stopped, camera bounds lifted), so the idiomatic reconnect is: discard
the old `ClientWorld`, build a new one, re-register the modules — exactly
what the demo clients do.
