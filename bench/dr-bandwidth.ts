/** Full 200-body, 60-second DR bandwidth scene, using built public package APIs. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  phaserMotionComponents,
  phaserNetworkComponents,
  Position,
  Rotation,
} from "@vworlds/vecs-phaser";
import { DeadReckoned, DeadReckonedModule, PhaserServerModule } from "@vworlds/vecs-phaser-server";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  Damping,
  LinearVelocity,
  Material,
  PhysicsModule,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  type VecsSocket,
  type CidLayout,
} from "@vworlds/vecs-protocol";
import { NetworkClient, Networked, ServerWorld, View } from "@vworlds/vecs-server";
import { Decoder, Encoder } from "@vworlds/vecs-wire";

const modes = ["streamed", "deadReckoned", "noRefresh"] as const;

function measure(mode: (typeof modes)[number]): object {
  const components = [...phaserNetworkComponents, ...phaserMotionComponents];
  const dr = mode !== "streamed";
  const server = new ServerWorld({
    name: "bandwidth",
    networkComponents: components,
    keepAliveFrames: dr ? 1 : undefined,
  });
  const client = new ClientWorld({
    networkComponents: components,
    serverTickIntervalMs: 1000 / 30,
    ackIntervalMs: 1e9,
  });
  let now = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  const mappedHash = createHash("sha256");
  const ids = new Map<number, number>();
  const capture: Uint8Array[] = [];
  let packets = 0;
  const previousNow = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  const serverSocket = new Socket("server");
  const clientSocket = new Socket("client");
  serverSocket.deliver = (data) => {
    if (now > 1000) {
      bytes += data.length;
      hash.update(data);
      const canonical = mapPacket(data, ids, server.cid);
      // Preserve packet boundaries and order in the hash, not just concatenated payload bytes.
      const length = Buffer.alloc(4);
      length.writeUInt32LE(canonical.length);
      mappedHash.update(length);
      mappedHash.update(canonical);
      if (process.env.BENCH_PACKET_PREFIX) {
        capture.push(length, canonical);
      }
      packets++;
    }
    clientSocket.receive(data);
  };
  clientSocket.deliver = (data) => serverSocket.receive(data);
  try {
    server.component(NetworkClient).on("set", (entity) => entity.set(View, { dsl: true }));
    server.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 30 });
    if (dr) {
      server.module(DeadReckonedModule, mode === "noRefresh" ? { maxBaselineAge: 0 } : {});
    } else {
      server.module(PhaserServerModule);
    }
    // Logical ids follow Networked creation order: clock (DR only), then the scene's bodies.
    // No component in this scene carries an entity reference inside its payload.
    for (const entity of server.entities.values()) {
      if (entity.has(Networked)) {
        ids.set(entity.eid, ids.size + 1);
      }
    }
    server.component(Networked).on("add", (entity) => ids.set(entity.eid, ids.size + 1));
    server._attach({
      on(_event, handler) {
        handler(serverSocket);
        return this;
      },
    });
    client.attachSocket(clientSocket);
    for (let i = 0; i < 200; i++) {
      const x = ((i % 20) - 10) * 12;
      const y = (Math.floor(i / 20) - 5) * 12;
      const turn = ((i * 37) % 100) / 100 - 0.5;
      const kind = i % 4;
      const body = server
        .entity()
        .add(Networked)
        .set(Body, { type: BodyType.Dynamic, bullet: kind === 0 })
        .set(PhysicsPosition, { x, y })
        .set(PhysicsRotation, { angle: 0 })
        .set(
          LinearVelocity,
          kind === 0
            ? { x: 30 * turn, y: 25 }
            : kind === 1
              ? { x: 2 * turn, y: 1 }
              : { x: 1.5 * turn, y: 0.5 }
        )
        .set(AngularVelocity, { value: kind === 0 ? 0 : kind === 1 ? turn : 0.8 * turn });
      if (kind === 1) {
        body.set(Damping, { linear: 0.15, angular: 0.15 * 0.66 });
      }
      if (dr) {
        body.add(DeadReckoned);
      } else {
        body.set(Position, { x, y }).set(Rotation, { angle: 0 });
      }
      server
        .entity()
        .childOf(body)
        .set(Circle, { radius: kind === 0 ? 0.1 : 0.5 })
        .set(Material, { restitution: 0 });
    }
    const dt = 1000 / 30;
    for (let frame = 1; frame <= 61 * 30; frame++) {
      now = (frame - 0.5) * dt;
      client.progress(now, dt / 2);
      now = frame * dt;
      server.progress(now, dt);
      client.progress(now, dt / 2);
      client.send();
    }
    if (process.env.BENCH_PACKET_PREFIX) {
      writeFileSync(`${process.env.BENCH_PACKET_PREFIX}-${mode}.bin`, Buffer.concat(capture));
    }
    return {
      bytes,
      bytesPerSecond: bytes / 60,
      packets,
      sha256: hash.digest("hex"),
      mappedPacketSha256: mappedHash.digest("hex"),
    };
  } finally {
    client.dispose();
    server.dispose();
    if (previousNow) {
      Object.defineProperty(performance, "now", previousNow);
    } else {
      Reflect.deleteProperty(performance, "now");
    }
  }
}

/** Re-encode only protocol entity ids; leave component payloads and list/packet order untouched. */
function mapPacket(data: Uint8Array, ids: ReadonlyMap<number, number>, cid: CidLayout): Uint8Array {
  const mappedId = (eid: number): number => {
    const id = ids.get(eid);
    if (id === undefined) {
      throw new Error(`unmapped network entity ${eid}`);
    }
    return id;
  };
  const message = Server2Client.decodeWith(cid, new Decoder(data));
  const diff = message.diff;
  if (diff) {
    diff.snapshots = diff.snapshots.map(({ bytes }) => {
      const snapshot = ComponentSnapshot.decodeWith(cid, new Decoder(bytes));
      snapshot.eid = mappedId(snapshot.eid);
      const encoder = new Encoder(new Uint8Array(bytes.length + 16));
      encoder.write(snapshot);
      return new EncodedSnapshot(encoder.getBuffer());
    });
    diff.removed = diff.removed.map(([eid, wireType]) => [mappedId(eid), wireType]);
    diff.resets = diff.resets?.map(([eid, frame]) => [mappedId(eid), frame]);
  }
  const encoder = new Encoder(new Uint8Array(data.length + 16));
  encoder.write(message);
  return encoder.getBuffer();
}

class Socket implements VecsSocket {
  public readonly id: string;
  public deliver: (data: Uint8Array) => void = () => {};
  private readonly _handlers = new Map<string, ((arg?: unknown) => void)[]>();

  public constructor(id: string) {
    this.id = id;
  }

  public on(event: "connect" | "disconnect" | "receive", handler: (arg?: unknown) => void): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.deliver(data.slice());
  }
  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }
  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

await preloadPhysics();
const results = Object.fromEntries(modes.map((mode) => [mode, measure(mode)]));
console.log(`BENCH_RESULT ${JSON.stringify({ bodies: 200, seconds: 60, modes: results })}`);
