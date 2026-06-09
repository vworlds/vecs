# vecs Demo Server

Authoritative server for the Phaser rendering demo. It owns the ECS world, physics simulation,
interest management, and replicated render components consumed by `apps/client`.

## Run

Start the demo server directly; it source-loads workspace packages through tsconfig path aliases,
so library changes reload without a build step.

```bash
npm install
npm run dev -w @vworlds/vecs-demo-server
```

The server listens on `http://localhost:3000` by default. Set `PORT` to use another HTTP port,
but keep the client in sync because the demo client connects to port `3000`.

Start the client in another shell after the server is running:

```bash
npm run dev -w @vworlds/vecs-demo-client
```

## Demo Behavior

- World units are meters with origin at the canvas center and +y upward.
- Balls are physics-driven `Arc` entities with `FillStyle`, `Position`, and `Rotation`.
- Players are `Rectangle` entities controlled by arrow-key input from connected clients.
- Scores are separate `Text` entities that follow each player and update when balls are collected.
- Decorative `Star`, `Triangle`, `Polygon`, `Ellipse`, and `Line` entities exercise every MVP renderable.
- Interest management uses the existing `View`/`EntityTracker` path; clients can toggle full-world vs nearby-grid visibility with `G`.

## Verification Notes

Restarting the server while the client stays open forces the client through disconnect,
baseline reset, and reconnect. The expected result is that all networked Phaser GameObjects are
torn down and rebuilt without console errors or leaked stale objects.
