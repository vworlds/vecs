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

Set `VECS_MCP_PORT` to opt into a separate loopback MCP listener for the `main`
world. Without it, no MCP server starts and the tick loop is unchanged. See
[MCP setup and security](../../lib/vecs-mcp/docs/getting-started.md#demo-server).

For browser client targets, the demo installs the bridge in Vite development
builds or when the page URL includes `?mcp` (also `&mcp` with other parameters).
See [browser clients](../../lib/vecs-mcp/docs/clients.md) for installation,
latency and which replicated changes the server overwrites.

Start the client in another shell after the server is running:

```bash
npm run dev -w @vworlds/vecs-demo-client
```

## Docker

Build the server image from the workspace root:

```bash
docker build -f apps/server/docker/Dockerfile -t vecs-demo-server .
```

The runtime image contains the compiled server, production dependencies, and embedded demo assets.
Set `PORT` to choose the HTTP signaling/assets port inside the container. Set
`VECS_WEBRTC_UDP_PORT` to force WebRTC data channels onto a single UDP port, and
`VECS_WEBRTC_UDP_HOST` to advertise the host/IP browsers should dial. If
`VECS_WEBRTC_UDP_HOST` is unset, it falls back to `VECS_HOST`:

```bash
docker run --rm -p 3900:3900 -p 3901:3901/udp -e PORT=3900 -e VECS_HOST=10.79.0.14 -e VECS_WEBRTC_UDP_PORT=3901 vecs-demo-server
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
