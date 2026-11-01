// A physics body's pose reaches clients through two writers: PhysicsPoseSyncOut copies Box2D's
// pose into the physics components, and PhaserServerModule copies that into the networked render
// pose. Both skip writes that would not change a value, so a networked body sends only the pose
// components that changed: a body flying straight never re-sends its Rotation, and a body at
// rest sends nothing.

import { ON_STORE, type Entity } from "@vworlds/vecs";
import {
  phaserNetworkComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  PhysicsModule,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
  Sleep,
} from "@vworlds/vecs-physics";
import {
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { NetworkClient, Networked, ServerWorld, View } from "@vworlds/vecs-server";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PhaserServerModule } from "../src/index.js";
import { CidLayout } from "@vworlds/vecs-protocol";

const testCid = new CidLayout(2 ** Math.ceil(Math.log2(phaserNetworkComponents.length + 1)));
const decodeServer2Client = {
  wireDecode: (decoder: Decoder) => Server2Client.decodeWith(testCid, decoder),
};
const decodeComponentSnapshot = {
  wireDecode: (decoder: Decoder) => ComponentSnapshot.decodeWith(testCid, decoder),
};

const STEP_MS = 1000 / 60;
/** Frames observed after the one that introduces the entity to the client. */
const FRAMES = 20;

// A wire type is the component's 1-based index in the server's `networkComponents`.
const POSITION = phaserNetworkComponents.indexOf(RenderPosition) + 1;
const ROTATION = phaserNetworkComponents.indexOf(RenderRotation) + 1;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }
}

class MockListener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public connect(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }
}

let now: number;
let world: ServerWorld;
let client: MemorySocket;

beforeAll(async () => {
  await preloadPhysics();
});

beforeEach(() => {
  now = 0;
  world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
  world.module(PhaserServerModule);

  // The client sees every networked entity.
  world.component(NetworkClient).on("set", (entity) => {
    entity.set(View, { dsl: true });
  });
  const listener = new MockListener();
  world._attach(listener);
  client = new MemorySocket("client-1");
  listener.connect(client);
});

/** A networked dynamic body whose physics and render poses start out equal. */
function createBody(motion: { linear: { x: number; y: number }; angular: number }): Entity {
  const body = world
    .entity()
    .add(Networked)
    .set(RenderPosition, { x: 0, y: 0 })
    .set(RenderRotation, { angle: 0.3 })
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsPosition, { x: 0, y: 0 })
    .set(PhysicsRotation, { angle: 0.3 })
    .set(LinearVelocity, motion.linear)
    .set(AngularVelocity, { value: motion.angular });
  world.entity().childOf(body).set(Box, { hx: 0.25, hy: 0.25 });
  return body;
}

/**
 * Advance one frame and return the wire types of the snapshots the client received for `entity`
 * in it, in order. The client acks each frame it receives, as a real one does, so every frame
 * carries only what changed since the previous one.
 */
function tick(entity: Entity): number[] {
  return tickSnapshots(entity).map((snapshot) => snapshot.wireType);
}

/** As {@link tick}, but return the received snapshots themselves, payloads included. */
function tickSnapshots(entity: Entity): ComponentSnapshot[] {
  const received = client.sent.length;
  world.progress(now, STEP_MS);
  now += STEP_MS;

  const snapshots: ComponentSnapshot[] = [];
  for (const bytes of client.sent.slice(received)) {
    const { diff } = new Decoder(bytes).read(decodeServer2Client);
    for (const encoded of diff?.snapshots ?? []) {
      const snapshot = new Decoder(encoded.bytes).read(decodeComponentSnapshot);
      if (snapshot.eid === entity.eid) {
        snapshots.push(snapshot);
      }
    }
    if (diff !== undefined) {
      client.receive(encodeMessage(new Client2Server({ ackFrame: diff.toFrame })));
    }
  }
  return snapshots;
}

function encodeMessage(message: Client2Server): Uint8Array {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(message);
  return encoder.getBuffer();
}

describe("pose replication", () => {
  it("never re-sends the Rotation of a body flying in a straight line", () => {
    const bullet = createBody({ linear: { x: 4, y: 0 }, angular: 0 });

    // The frame that introduces the entity carries everything it has.
    expect(tick(bullet)).toEqual([POSITION, ROTATION]);

    // From then on only the Position, which changes every frame, is replicated.
    for (let frame = 1; frame <= FRAMES; frame++) {
      expect(tick(bullet)).toEqual([POSITION]);
    }
  });

  it("sends nothing for an awake body at rest", () => {
    // Without this a body at rest falls asleep and Box2D stops reporting it, which would make
    // "nothing is sent" true for the wrong reason.
    const parked = createBody({ linear: { x: 0, y: 0 }, angular: 0 }).set(Sleep, {
      enabled: false,
    });
    // The server sends no frame when nothing changed, so a client's acks stall and, after a few
    // idle frames, the server resends the whole view. An entity that changes every frame keeps
    // frames flowing, as in any live world.
    const beacon = world.entity().add(Networked).set(RenderPosition, { x: 0, y: 0 });

    expect(tick(parked)).toEqual([POSITION, ROTATION]);

    for (let frame = 1; frame <= FRAMES; frame++) {
      const framesSent = client.sent.length;
      beacon.set(RenderPosition, { x: frame, y: 0 });

      expect(tick(parked)).toEqual([]);
      // A frame did go out: it carried the beacon and nothing about the parked body.
      expect(client.sent.length).toBe(framesSent + 1);
    }
  });

  it("still replicates the Rotation of a body that turns", () => {
    const spinner = createBody({ linear: { x: 4, y: 0 }, angular: 2 });

    expect(tick(spinner)).toEqual([POSITION, ROTATION]);

    for (let frame = 1; frame <= FRAMES; frame++) {
      expect(tick(spinner)).toEqual([POSITION, ROTATION]);
    }
  });
});

// The sync systems write the render pose into the existing component and mark it modified instead
// of calling `set`, so these tests pin what that write must still reach: the `update` watchers of
// the render pose and the replication to clients, including the replication of a component whose
// previous encoding the server has already cached.
describe("render pose replication from the sync systems", () => {
  /** A networked entity whose render pose equals its physics pose, already sent to the client. */
  function createSyncedEntity(): Entity {
    const entity = world
      .entity()
      .add(Networked)
      .set(RenderPosition, { x: 3, y: 4 })
      .set(RenderRotation, { angle: 1.5 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });
    expect(tick(entity)).toEqual([POSITION, ROTATION]);
    return entity;
  }

  it("replicates a changed physics pose once, with the value it changed to", () => {
    const entity = createSyncedEntity();

    entity.set(PhysicsPosition, { x: 5, y: 6 }).set(PhysicsRotation, { angle: 2.5 });
    const snapshots = tickSnapshots(entity);

    // The introducing frame cached both encodings, so the new values prove the write reached
    // replication and invalidated them.
    expect(snapshots.map((snapshot) => snapshot.wireType)).toEqual([POSITION, ROTATION]);
    expect(new Decoder(snapshots[0].payload).read(RenderPosition)).toMatchObject({ x: 5, y: 6 });
    expect(new Decoder(snapshots[1].payload).read(RenderRotation)).toMatchObject({ angle: 2.5 });

    // Nothing changed since, so nothing is sent again.
    expect(tick(entity)).toEqual([]);
  });

  it("replicates nothing when the physics pose is set to the value the render pose holds", () => {
    const entity = createSyncedEntity();
    // The server sends no frame when nothing changed. A beacon that changes every frame keeps
    // frames flowing, so the entity's silence is visible in them.
    const beacon = world.entity().add(Networked).set(RenderPosition, { x: 0, y: 0 });
    expect(tick(beacon)).toEqual([POSITION]);

    for (let frame = 1; frame <= FRAMES; frame++) {
      const framesSent = client.sent.length;
      beacon.set(RenderPosition, { x: frame, y: 0 });
      entity.set(PhysicsPosition, { x: 3, y: 4 }).set(PhysicsRotation, { angle: 1.5 });

      expect(tick(entity)).toEqual([]);
      // A frame did go out: it carried the beacon and nothing about the entity.
      expect(client.sent.length).toBe(framesSent + 1);
    }
  });

  it("fires the update watchers of the render pose and replicates it for a changed pose", () => {
    const watched: { x: number; y: number }[] = [];
    world
      .system("RenderPositionWatcher")
      .with(RenderPosition)
      .phase(ON_STORE)
      .update(RenderPosition, (_entity, position) => {
        watched.push({ x: position.x, y: position.y });
      });
    const entity = createSyncedEntity();
    expect(watched).toEqual([]);

    entity.set(PhysicsPosition, { x: 5, y: 6 });
    const snapshots = tickSnapshots(entity);

    expect(watched).toEqual([{ x: 5, y: 6 }]);
    expect(snapshots.map((snapshot) => snapshot.wireType)).toEqual([POSITION]);
    expect(new Decoder(snapshots[0].payload).read(RenderPosition)).toMatchObject({ x: 5, y: 6 });
  });

  it("introduces an entity with the physics pose it entered with, not the render pose it had", () => {
    const entity = world
      .entity()
      .add(Networked)
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });

    const snapshots = tickSnapshots(entity);

    expect(snapshots.map((snapshot) => snapshot.wireType)).toEqual([POSITION, ROTATION]);
    expect(new Decoder(snapshots[0].payload).read(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(new Decoder(snapshots[1].payload).read(RenderRotation)).toMatchObject({ angle: 1.5 });
  });
});
