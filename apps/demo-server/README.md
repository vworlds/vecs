# Tank Arena — server

The authoritative game server for the **Tank Arena** teaching demo: a small
multiplayer arcade game (drive a tank, shells ricochet off walls, last hit
scores) that exercises the entire vecs stack — replication, physics, animated
sprites, audio, camera control, screen-space HUD, particles, and the input
toolkit. Read it side by side with
[`lib/vecs-phaser/docs/design-guide.md`](../../lib/vecs-phaser/docs/design-guide.md).

## Run it

```bash
npm install
npm run dev -w @vworlds/vecs-tanks-server     # HTTP + signaling on :3000
npm run dev -w @vworlds/vecs-tanks-client     # Vite, usually :5173
```

Open several browser tabs on the Vite URL to fight yourself.

## Layout

| Path                          | What it teaches                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | World/pipeline boot: Express, `ServerWorld`, physics, `PhaserServerModule`, fixed-step loop.                                                             |
| `src/game/config.ts`          | All tunables in meters/seconds; the shared input action order.                                                                                           |
| `src/game/module.ts`          | The umbrella module composing feature modules in dependency order.                                                                                       |
| `src/game/modules/assets/`    | Typed asset handles (`AssetManager`) as world-global state; catalog mounting.                                                                            |
| `src/game/modules/arena/`     | Static physics (chain border, box obstacles) + replicated visuals.                                                                                       |
| `src/game/modules/tanks/`     | Connection → tank lifecycle, `PlayerInput` driving, presence-driven track `Animation`, respawns, per-session camera.                                     |
| `src/game/modules/shells/`    | Cooldown firing, bouncing bullet bodies, reactive `ContactEvents` impact handling, one-shot explosion entities (`ParticleBurst` + `Sound` + `Lifetime`). |
| `src/game/modules/hud/`       | Replicated screen-space HUD with `ScreenAnchor`; reactive score rows.                                                                                    |
| `scripts/generate-assets.mjs` | The committed tileset/`.tsj`/WAV assets, generated from code.                                                                                            |

## Assets

`assets/` is committed and generated — `node scripts/generate-assets.mjs`
rebuilds the tileset PNG (tanks, shell, explosion frames, spark, wall), the
Tiled `.tsj` (including the track/explosion animations the client plays), and
the WAV sound effects.
