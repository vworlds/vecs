import { describe, expect, it } from "vitest";
import { type as wireType, Decoder } from "@vworlds/vecs-wire";
import type { EID, Entity } from "@vworlds/vecs";
import {
  ALL_COMPONENTS,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Networked, NetworkClient, ServerWorld, View } from "@vworlds/vecs-server";
import { ClientWorld } from "../src/index.js";

// Regression coverage for the "inactive tab" reset storm.
//
// When a browser tab goes inactive its requestAnimationFrame loop stops (so
// ClientWorld.apply / DiffBuffer.pull never runs) and its ack setInterval is
// throttled to ~1Hz. The server stops seeing acks, decides the client has
// fallen outside its history window, and streams full baselines
// (StateDiff.fromFrame === 0) every frame until the client catches up. The
// dgram transport vecs uses in production is unordered with maxRetransmits=2,
// so some of those packets are dropped or reordered.
//
// Each baseline is the *complete* authoritative state at its frame, and the
// client adopts it as reset-then-rebuild: every server-owned entity is destroyed
// and then recreated from the snapshot. Recreating fires each entity's `enter`
// again, so view systems that attach client-side state on enter rebuild it -- the
// behaviour this test pins down. After the storm the world must match the server
// exactly, and the survivor must have been torn down and rebuilt (its `enter`
// ran again), not merely updated in place.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

// A static networked component -- like spacerocks' Drawable. The server sets it
// once and never changes it, so normal-play deltas never re-send it; only a full
// baseline does. The client enriches it on `enter` with `view`, view-only state
// the server never sends. A baseline rebuild recreates the entity, so `enter`
// runs again and repopulates `view`; an in-place reconcile re-attaches a fresh
// Sprite without firing `enter`, leaving `view` empty.
class Sprite {
  @wireType("i32")
  public kind = 0;

  public view: string | undefined = undefined;
}

const TICK_MS = 1000 / 30;

type SocketHandler = (arg?: unknown) => void;

class Endpoint implements VecsSocket {
  public peer!: Endpoint;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  // Forwards what this endpoint sends to its peer. `gate` lets a test drop the
  // packet (modelling the lossy data channel) before it reaches the peer.
  public send(data: Uint8Array): void {
    if (this.gate(data)) {
      this.peer._emit("receive", data);
    }
  }

  public gate: (data: Uint8Array) => boolean = () => true;

  public close(): void {
    this._emit("disconnect");
  }

  private _emit(event: string, arg?: unknown): void {
    this._handlers.get(event)?.forEach((handler) => handler(arg));
  }
}

class Listener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public accept(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

function createServer(): ServerWorld {
  const server = new ServerWorld({
    name: "main",
    networkComponents: [Position, Sprite],
    disconnectGraceMs: 1e9, // keep the session alive across the synchronous run
  });
  server.component(NetworkClient).onSet((entity) => {
    entity.set(View, { dsl: true }); // every client sees every networked entity
  });
  server.installSystems();
  server.start();
  return server;
}

function networkEntities(world: ClientWorld): Entity[] {
  const pool = world.pools.find((p) => p.name === "network_entity");
  if (!pool) {
    return [];
  }
  return [...world.entities.values()].filter(
    (entity) => entity.eid >= pool.min && (pool.max === undefined || entity.eid <= pool.max)
  );
}

function clientState(world: ClientWorld): Map<EID, { x: number; y: number }> {
  const state = new Map<EID, { x: number; y: number }>();
  for (const entity of networkEntities(world)) {
    const position = entity.get(Position);
    if (position) {
      state.set(entity.eid, { x: position.x, y: position.y });
    }
  }
  return state;
}

function serverState(live: Set<Entity>): Map<EID, { x: number; y: number }> {
  const state = new Map<EID, { x: number; y: number }>();
  for (const entity of live) {
    const position = entity.get(Position)!;
    state.set(entity.eid, { x: position.x, y: position.y });
  }
  return state;
}

function diffRemoves(packet: Uint8Array, eid: EID): boolean {
  const message = new Decoder(packet).read(Server2Client);
  return message.diff?.removed.some(([e, type]) => e === eid && type === ALL_COMPONENTS) ?? false;
}

describe("reset storm (inactive tab)", () => {
  it("tears down and rebuilds server entities on every baseline, re-firing enter", () => {
    const server = createServer();
    const listener = new Listener();
    server._attach(listener);

    const client = new ClientWorld({
      networkComponents: [Position, Sprite],
      serverTickIntervalMs: TICK_MS,
      interpolatorBucketLength: 3,
      ackIntervalMs: 1e9, // never auto-fire; the test drives acks via client.send()
    });

    // A view system enriches each entity's Sprite on `enter`. It must run again
    // whenever a baseline rebuilds the entity, or the enrichment is lost. We
    // count enters per entity and stamp the (client-only) `view` field.
    const enters = new Map<EID, number>();
    client
      .query("view")
      .with(Sprite)
      .enter([Sprite], (entity: Entity, [sprite]: [Sprite]) => {
        enters.set(entity.eid, (enters.get(entity.eid) ?? 0) + 1);
        sprite.view = "built";
      })
      .build();

    let resets = 0;
    client.events.on("reset", () => {
      resets++;
    });

    const clientEp = new Endpoint("client");
    const serverEp = new Endpoint("client-1");
    clientEp.peer = serverEp;
    serverEp.peer = clientEp;
    client.attachSocket(clientEp);
    listener.accept(serverEp);

    const asteroids = [
      server.entity().add(Networked).set(Position, { x: 0, y: 10 }).set(Sprite, { kind: 1 }),
      server.entity().add(Networked).set(Position, { x: 0, y: 20 }).set(Sprite, { kind: 1 }),
      server.entity().add(Networked).set(Position, { x: 0, y: 30 }).set(Sprite, { kind: 1 }),
      server.entity().add(Networked).set(Position, { x: 0, y: 40 }).set(Sprite, { kind: 1 }),
    ];
    const live = new Set(asteroids);
    const doomed = asteroids[2];
    const survivor = asteroids[0];

    let frame = 0;
    let now = 0;
    const drift = (): void => {
      for (const entity of live) {
        const position = entity.get(Position)!;
        entity.set(Position, { x: position.x + 1, y: position.y });
      }
    };

    // --- normal play: pulls and acks flow every frame ---
    for (let i = 0; i < 6; i++) {
      drift();
      server.progress(frame++ * TICK_MS, TICK_MS);
      now += TICK_MS;
      client.apply(now);
      client.send();
    }
    expect(clientState(client).size).toBe(4);
    // The survivor entered the world and a view system built its view.
    expect(enters.get(survivor.eid)).toBeGreaterThanOrEqual(1);
    expect((client.entity(survivor.eid).get(Sprite) as Sprite).view).toBe("built");
    const entersBeforeStorm = enters.get(survivor.eid)!;

    // --- tab inactive: no pulls and no acks (a deeply backgrounded tab whose
    // setInterval is frozen too). The server stays in continuous baseline/resync
    // mode. The transport systematically drops any packet carrying the doomed
    // entity's removal -- its retransmits expired while the tab slept. ---
    serverEp.gate = (data) => !diffRemoves(data, doomed.eid);
    for (let i = 0; i < 40; i++) {
      drift();
      if (i === 18) {
        live.delete(doomed);
        doomed.destroy();
      }
      server.progress(frame++ * TICK_MS, TICK_MS);
    }
    serverEp.gate = () => true;

    // --- tab wakes up, then a few quiet fully-synced frames to converge ---
    for (let i = 0; i < 6; i++) {
      now += TICK_MS;
      client.apply(now);
      client.send();
    }
    for (let i = 0; i < 8; i++) {
      server.progress(frame++ * TICK_MS, TICK_MS);
      now += TICK_MS;
      client.apply(now);
      client.send();
    }

    expect(resets).toBeGreaterThan(0);
    // The world matches the server exactly: the doomed entity is gone even
    // though its removal packet was never delivered.
    expect(clientState(client)).toEqual(serverState(live));
    expect(networkEntities(client).some((e) => e.eid === doomed.eid)).toBe(false);
    // The survivor was torn down and rebuilt across the storm, so its `enter`
    // ran again beyond the initial entry...
    expect(enters.get(survivor.eid)!).toBeGreaterThan(entersBeforeStorm);
    // ...and that rebuild repopulated its client-only view state on the fresh
    // Sprite -- the regression: an in-place reconcile would leave it empty.
    expect((client.entity(survivor.eid).get(Sprite) as Sprite).view).toBe("built");

    client.close();
  });
});
