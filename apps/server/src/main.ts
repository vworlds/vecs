import express from "express";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { AssetManager, PhaserServerModule } from "@vworlds/vecs-phaser-server";
import { PhysicsModule, preloadPhysics } from "@vworlds/vecs-physics";
import { ServerWorld, VecsListener } from "@vworlds/vecs-server";
import { DT, DT_MS, PORT, WEBRTC_UDP_HOST, WEBRTC_UDP_PORT } from "./demo/config.js";
import { DemoModule } from "./demo/module.js";

const world = new ServerWorld({ name: "main", networkComponents: phaserNetworkComponents });
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

await preloadPhysics();
world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: DT, subSteps: 4 });
world.module(PhaserServerModule);
world.module(DemoModule, {
  app,
  assets: new AssetManager({ assetsPath: "assets" }),
  worldName: world.name,
});

if (process.env.VECS_MCP_PORT) {
  const { VecsMcpServer } = await import("@vworlds/vecs-mcp");
  const mcp = new VecsMcpServer();
  mcp.registerWorld(world);
  const port = await mcp.listen(Number(process.env.VECS_MCP_PORT));
  if (process.env.VECS_MCP_HUB) {
    mcp.join(process.env.VECS_MCP_HUB);
  }
  console.log(`vecs MCP listening on http://127.0.0.1:${port}/mcp`);
}

const vecsListener = new VecsListener();
vecsListener.registerWorld(world);
await vecsListener.listen(app, createDgramOptions());

app.get("/", (_req, res) => {
  res.type("text/plain").send("vecs demo server running. Start apps/client with Vite.");
});

app.listen(PORT, () => {
  console.log(`vecs demo server listening on http://localhost:${PORT}`);
});

let previous = performance.now();
let accumulator = 0;
let tick = 0;

function loop(): void {
  const now = performance.now();
  let frameTime = now - previous;
  previous = now;

  frameTime = Math.min(frameTime, 250);
  accumulator += frameTime;

  while (accumulator >= DT_MS) {
    simulate(DT, tick++);
    accumulator -= DT_MS;
  }

  setTimeout(loop, Math.max(0, DT_MS - accumulator));
}

loop();

function simulate(dt: number, tick: number): void {
  world.progress((tick + 1) * DT_MS, dt * 1000);
}

function createDgramOptions(): Record<string, unknown> {
  return {
    ordered: false,
    maxRetransmits: 2,
    ...(WEBRTC_UDP_PORT === undefined
      ? {}
      : {
          enableIceUdpMux: true,
          advertisedUdpHost: WEBRTC_UDP_HOST,
          advertisedUdpPort: WEBRTC_UDP_PORT,
          portRange: { min: WEBRTC_UDP_PORT, max: WEBRTC_UDP_PORT },
        }),
  };
}
