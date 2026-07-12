# Audio

Replicated sound with two components: one-shot `Sound` and long-lived
`Music`. The client needs one module registration:

```ts
world.module(AudioModule, { scene });
```

Audio assets come from the catalog (`AssetManager.getAudio(key)` on the
server, loaded by `loadAssets` on the client) and are referenced by numeric
id — see [Assets](./assets.md).

## `Sound`: one-shot per set

The client plays the asset every time the component is **set** (including
entry). Two idiomatic shapes:

```ts
// 1. A self-cleaning effect entity — fire and forget:
world
  .entity()
  .add(Networked)
  .set(Sound, { asset: fire.id, volume: 0.5 })
  .set(Lifetime, { seconds: 0.5 }); // server destroys it; removal replicates

// 2. Re-trigger on a live entity (a repeating fire sound):
tank.set(Sound, { asset: fire.id }); // each set = one play
```

Prefer shape 1 for events: a baseline resend replays the _latest_ set of a
living component, so a long-lived `Sound` would replay on reconnect. A
short-lived entity is gone before late joiners ever see it.

## `Music`: plays while present

```ts
world.entity().add(Networked).set(Music, { asset: theme.id, volume: 0.6 });
// later…
entity.set(Music, { asset: theme.id, volume: 0.2, loop: true }); // live adjust, no restart
entity.remove(Music); // stops
```

One playback per entity. Removal, entity destruction, and baseline resets
all stop it through the same hook (the client-local `MusicPlayback` wrapper
is removed → its `onRemove` stops and disposes the Phaser sound) — no client
bookkeeping.

## Notes

- Volumes are 0..1; `Sound.rate` is a playback-rate multiplier (pitch/speed).
- Browsers block audio before the first user gesture; Phaser unlocks its
  sound manager on the first input automatically. Expect silence until the
  player clicks/taps.
- There is no spatialization yet — attenuate by distance server-side (lower
  `volume` for far-away listeners' views) or client-side in game code if you
  need it.
