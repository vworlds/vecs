/** Real physics/DR gate cost. Run with register-dist; BENCH_IDLE_KEEPALIVE=1 enables the gate. */
import { performance } from "node:perf_hooks";
import { type Entity } from "@vworlds/vecs";
import { phaserMotionComponents, phaserNetworkComponents, MotionClock } from "@vworlds/vecs-phaser";
import {
  PhysicsModule,
  preloadPhysics,
  Body,
  BodyType,
  Circle,
  Position,
  LinearVelocity,
  Sleep,
} from "@vworlds/vecs-physics";
import { DeadReckoned, DeadReckonedModule } from "@vworlds/vecs-phaser-server";
import { Networked, NetworkClient, ServerWorld, View } from "@vworlds/vecs-server";
import {
  Client2Server,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder } from "@vworlds/vecs-wire";

class Region0 {}
class Region1 {}
class Region2 {}
class Region3 {}
const REGIONS = [Region0, Region1, Region2, Region3];
const idleKeepAlive = process.env.BENCH_IDLE_KEEPALIVE === "1";
const bodies = Number(process.env.BENCH_DR_BODIES ?? 200);
const ticks = Number(process.env.BENCH_TICKS ?? 600);
await preloadPhysics();
const world = new ServerWorld({
  networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
  keepAliveFrames: 1,
});
world.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
world.module(DeadReckonedModule, { idleKeepAlive });
REGIONS.forEach((tag) => world.component(tag));
world.component(NetworkClient).on("set", (entity, client) => {
  entity.set(View, { dsl: { any: [REGIONS[Number(client.id) % REGIONS.length], MotionClock] } });
});
for (let i = 0; i < bodies; i++) {
  const body = world
    .entity()
    .add(Networked)
    .add(REGIONS[i % REGIONS.length])
    .add(DeadReckoned)
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: (i % 20) * 4, y: Math.floor(i / 20) * 4 })
    .set(LinearVelocity, { x: 0.2 })
    .set(Sleep, { enabled: false });
  world.entity().childOf(body).set(Circle, { radius: 0.5 });
}

type Handler = (value?: unknown) => void;
class Socket implements VecsSocket {
  public readonly id: string;
  public frame = 0;
  private readonly _handlers = new Map<string, Handler[]>();
  public constructor(id: string) {
    this.id = id;
  }
  public on(event: "connect" | "disconnect" | "receive", handler: Handler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
    return this;
  }
  public send(data: Uint8Array): void {
    this.frame = new Decoder(data).read(Server2Client).diff?.toFrame ?? this.frame;
  }
  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
  public ack(): void {
    const encoder = new Encoder(new Uint8Array(32));
    encoder.write(new Client2Server({ ackFrame: this.frame }));
    this._handlers.get("receive")?.forEach((handler) => handler(encoder.getBuffer()));
  }
}
let accept: (socket: VecsSocket) => void = () => {};
const listener: VecsSocketListener = {
  on(_event, handler) {
    accept = handler;
    return this;
  },
};
world._attach(listener);
const sockets = Array.from({ length: 8 }, (_, i) => new Socket(String(i)));
sockets.forEach((socket) => accept(socket));
const actors: Entity[] = [...world.entities.values()].filter((entity) => entity.has(DeadReckoned));
let now = 0;
const step = (): void => {
  // Structural mutation routing is part of the enabled cost, not just steady-state count reads.
  const actor = actors[Math.floor(now / (1000 / 30)) % actors.length];
  const region = REGIONS[Math.floor(now / 1000) % REGIONS.length];
  for (const tag of REGIONS) {
    if (tag !== region && actor.has(tag)) {
      actor.remove(tag);
    }
  }
  actor.add(region);
  world.progress(now, 1000 / 30);
  now += 1000 / 30;
  sockets.forEach((socket) => socket.ack());
};
for (let i = 0; i < 150; i++) {
  step();
}
const start = performance.now();
for (let i = 0; i < ticks; i++) {
  step();
}
const meanTickMs = (performance.now() - start) / ticks;
const trackers = (world as unknown as { _trackerCache: { _trackers: Map<number, unknown> } })
  ._trackerCache._trackers.size;
console.log(
  "DR_GATE_RESULT",
  JSON.stringify({
    idleKeepAlive,
    bodies,
    clients: sockets.length,
    distinctViews: REGIONS.length,
    trackers,
    meanTickMs,
  })
);
world.dispose();
