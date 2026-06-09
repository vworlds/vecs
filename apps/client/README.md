# vecs Demo Client

Phaser client for the server-driven rendering demo. The client connects to `apps/server`,
receives replicated vecs render components, and lets `PhaserRenderModule` create/update/destroy
GameObjects automatically.

## Run

Start the demo directly; Vite aliases workspace packages to source, so client and Phaser package
changes hot-reload without a build step.

```bash
npm install
npm run dev -w @vworlds/vecs-demo-server
npm run dev -w @vworlds/vecs-demo-client
```

Open the Vite URL printed by the client, usually `http://localhost:5173/`. If that port is busy,
Vite will choose the next available port.

## Controls

- Arrow keys move the player rectangle.
- `G` toggles between full-world visibility and nearby-grid visibility.

## Browser Requirements

Use a browser/runtime where WebRTC data channels can open. A browser can load the Phaser chrome
without opening the dgram data channel, which leaves the grid visible but prevents replicated
entities from appearing. Headed Chrome is the safest verification path; headless environments must
be configured so WebRTC data channels work.

## Expected Scene

- The server origin `(0, 0)` maps to the canvas center; positive y renders upward.
- Balls render from `Arc` + `FillStyle` components and move smoothly between server ticks.
- Player rectangles and score `Text` render from replicated components with no per-entity render
  code in the client.
- `Star`, `Triangle`, `Polygon`, `Ellipse`, and `Line` decorations appear from server-authored
  render components.
- Rotating arcs and decorative vertex shapes make rotation/pivot behavior visible.
- Restarting the server while the client stays open rebuilds the replicated GameObjects after
  reconnect.

## Evidence

The VPH-42 verification screenshots are committed next to this README:

- `vph42-demo.png`: connected demo with full-world visibility.
- `vph42-demo-after-reset.png`: same client after a server restart and reconnect.
