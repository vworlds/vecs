# Tank Arena — client

The browser client for the **Tank Arena** teaching demo. It is deliberately
thin — `src/main.ts` is the whole client:

1. **BootScene** awaits `loadAssets` (catalog fetch → Phaser loader →
   animation registration) so no diff can reference a missing texture.
2. **GameScene** connects a `ClientWorld` and registers the vecs-phaser
   client modules: `PhaserRenderModule` (auto-rendering), `CameraModule`
   (server-driven camera), `AudioModule` (replicated sound), `EffectsModule`
   (particle bursts), and `InputCaptureModule` (keyboard + pointer/touch →
   `setInput`).
3. `update()` calls `world.progress(time, delta)`. That's it.

Everything on screen is replicated server state; there is no per-entity
render code and no gameplay logic in the client.

## Run it

```bash
npm install
npm run dev -w @vworlds/vecs-tanks-server     # in one shell
npm run dev -w @vworlds/vecs-tanks-client     # in another
```

Controls: **WASD / arrows** to drive, **SPACE** to fire. Open several tabs
to play against yourself. On touch devices the pointer state is captured and
sent too — see the design guide for building a virtual joystick on
`LocalInput`.

`public/vars.js` carries the connection options (host/port/world),
overridable at deploy time exactly like the original demo client.
