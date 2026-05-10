import express from "express";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Networked, VecsServer, VecsServerWorld } from "@vworlds/vecs-server";
import { World } from "@vworlds/vecs";

const POSITION_TYPE = 1;
const PORT = Number(process.env.PORT ?? 3000);

class Position {
  public x = 0;
  public y = 0;

  public wireEncode(encoder: Encoder): void {
    encoder.write_f32(this.x);
    encoder.write_f32(this.y);
  }

  public static wireDecode(decoder: Decoder): Position {
    const position = new Position();
    position.x = decoder.read_f32();
    position.y = decoder.read_f32();
    return position;
  }
}

class Velocity {
  public x = 0;
  public y = 0;
}

const world = new World();
world.registerComponent(Networked);
world.registerComponent(Position, POSITION_TYPE);
world.registerComponent(Velocity);

const app = express();
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

const vecsServer = new VecsServer();
const mainWorld: VecsServerWorld = vecsServer.registerWorld("main", world);
mainWorld.registerComponent(Position);

for (let i = 0; i < 12; i++) {
  world
    .entity()
    .add(Networked)
    .set(Position, { x: 80 + i * 70, y: 120 + (i % 3) * 90 })
    .set(Velocity, { x: 35 + i * 3, y: 25 + i * 2 });
}

world
  .system("MoveDots")
  .requires(Networked, Position, Velocity)
  .each([Position, Velocity], (entity, [position, velocity]) => {
    position.x += velocity.x / 30;
    position.y += velocity.y / 30;

    if (position.x < 20 || position.x > 940) {
      velocity.x *= -1;
    }
    if (position.y < 60 || position.y > 520) {
      velocity.y *= -1;
    }

    entity.modified(Position);
  });

mainWorld.installSystems();
world.start();
await vecsServer.listen(app, { ordered: false, maxRetransmits: 2 });

app.get("/", (_req, res) => {
  res.type("text/plain").send("vecs demo server running. Start apps/client with Vite.");
});

app.listen(PORT, () => {
  console.log(`vecs demo server listening on http://localhost:${PORT}`);
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  world.progress(now, now - last);
  last = now;
}, 1000 / 30);
