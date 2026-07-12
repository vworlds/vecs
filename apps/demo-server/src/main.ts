/**
 * Tank Arena — server entry point.
 *
 * Boots Express (asset catalog + WebRTC signaling), builds the authoritative
 * `ServerWorld` with the vecs-phaser network components, installs physics,
 * the Phaser server glue, and the game module, then drives a fixed-timestep
 * loop. Everything gameplay-related lives in `src/game/` as ECS modules.
 */
import express from "express";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { AssetManager, PhaserServerModule } from "@vworlds/vecs-phaser-server";
import { PhysicsModule, preloadPhysics } from "@vworlds/vecs-physics";
import { ServerWorld, VecsListener } from "@vworlds/vecs-server";
import { DT, DT_MS, PORT, WEBRTC_UDP_HOST, WEBRTC_UDP_PORT } from "./game/config.js";
import { TankArenaModule } from "./game/module.js";

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
// Top-down arena: no gravity. Shells/tanks live purely in the XY plane.
world.module(PhysicsModule, { fixedTimeStep: DT, gravity: { x: 0, y: 0 }, subSteps: 4 });
world.module(PhaserServerModule);
world.module(TankArenaModule, {
  app,
  assets: new AssetManager({ assetsPath: "assets" }),
  worldName: world.name,
});

const vecsListener = new VecsListener();
vecsListener.registerWorld(world);
await vecsListener.listen(app, createDgramOptions());

app.get("/", (_req, res) => {
  res.type("text/plain").send("Tank Arena server running. Start apps/demo-client with Vite.");
});

app.listen(PORT, () => {
  console.log(`Tank Arena server listening on http://localhost:${PORT}`);
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
    world.progress(++tick * DT_MS, DT * 1000);
    accumulator -= DT_MS;
  }

  setTimeout(loop, Math.max(0, DT_MS - accumulator));
}

loop();

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
        }),
  };
}
