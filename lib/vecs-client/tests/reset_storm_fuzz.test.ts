import { describe, expect, it } from "vitest";
import { type as wireType } from "@vworlds/vecs-wire";
import type { EID, Entity } from "@vworlds/vecs";
import type { VecsSocket, VecsSocketListener } from "@vworlds/vecs-protocol";
import { Networked, NetworkClient, ServerWorld, View } from "@vworlds/vecs-server";
import { ClientWorld } from "../src/index.js";

// Robustness sweep for the inactive-tab reset storm (see reset_storm.test.ts
// for the narrated, deterministic case). Drives a real ServerWorld <-> a real
// ClientWorld over a transport that drops/reorders/duplicates packets like the
// production dgram data channel (unordered, maxRetransmits=2), while alternating
// "active" and "inactive(tab)" windows. After a final reliably-delivered settle
// phase the client must match the server exactly, for every seed.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

const TICK_MS = 1000 / 30;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type SocketHandler = (arg?: unknown) => void;

class Channel {
  public readonly queue: Uint8Array[] = [];
  public push(data: Uint8Array): void {
    this.queue.push(data);
  }
}

class Endpoint implements VecsSocket {
  public outbound!: Channel;
  private readonly _handlers = new Map<string, SocketHandler[]>();
  public constructor(public readonly id: string) {}
  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }
  public send(data: Uint8Array): void {
    this.outbound.push(data);
  }
  public close(): void {
    this._emit("disconnect");
  }
  public deliver(data: Uint8Array): void {
    this._emit("receive", data);
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
    networkComponents: [Position],
    disconnectGraceMs: 1e9,
  });
  server.component(NetworkClient).onSet((entity) => entity.set(View, { dsl: true }));
  server.installSystems({ collectPhase: "update", sendPhase: "update" });
  server.start();
  return server;
}

function networkEntities(world: ClientWorld): Entity[] {
  const pool = world.pools.find((p) => p.name === "network_entity");
  if (!pool) {
    return [];
  }
  return [...world.entities.values()].filter(
    (e) => e.eid >= pool.min && (pool.max === undefined || e.eid <= pool.max)
  );
}

type Mode = "drop" | "reorder";

function runScenario(seed: number, mode: Mode): { ok: boolean; reason: string } {
  const rng = mulberry32(seed);
  const server = createServer();
  const listener = new Listener();
  server._attach(listener);
  const client = new ClientWorld({
    networkComponents: [Position],
    serverTickIntervalMs: TICK_MS,
    interpolatorBucketLength: 3,
    ackIntervalMs: 1e9,
  });
  let err: string | undefined;
  // No application-side reset handling: convergence must come entirely from the
  // interpolator rebasing onto each baseline.

  const s2c = new Channel();
  const c2s = new Channel();
  const clientEp = new Endpoint("client");
  const serverEp = new Endpoint("client-1");
  clientEp.outbound = c2s;
  serverEp.outbound = s2c;
  client.attachSocket(clientEp);
  listener.accept(serverEp);

  const flush = (channel: Channel, target: Endpoint, lossy: boolean): void => {
    let packets = channel.queue.splice(0);
    if (lossy) {
      if (mode === "reorder") {
        for (let i = packets.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [packets[i], packets[j]] = [packets[j], packets[i]];
        }
      }
      const kept: Uint8Array[] = [];
      for (const p of packets) {
        if (rng() < 0.35) {
          continue;
        } // drop
        kept.push(p);
        if (mode === "reorder" && rng() < 0.1) {
          kept.push(p);
        } // duplicate
      }
      packets = kept;
    }
    for (const p of packets) {
      try {
        target.deliver(p);
      } catch (e) {
        err = err ?? (e as Error).message;
      }
    }
  };

  const ents = [
    server.entity().add(Networked).set(Position, { x: 0, y: 10 }),
    server.entity().add(Networked).set(Position, { x: 0, y: 20 }),
    server.entity().add(Networked).set(Position, { x: 0, y: 30 }),
    server.entity().add(Networked).set(Position, { x: 0, y: 40 }),
  ];
  const live = new Set(ents);
  let frame = 0;
  let now = 0;
  const drift = (): void => {
    for (const e of live) {
      const p = e.get(Position)!;
      e.set(Position, { x: p.x + 1, y: p.y });
    }
    if (rng() < 0.04 && live.size > 1) {
      const arr = [...live];
      const v = arr[Math.floor(rng() * arr.length)];
      live.delete(v);
      v.destroy();
    }
    if (rng() < 0.04) {
      live.add(server.entity().add(Networked).set(Position, { x: 300, y: 5 }));
    }
  };

  // chaotic phase: alternate active / inactive(tab) windows
  let active = true;
  let windowLeft = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < 220; i++) {
    if (windowLeft-- <= 0) {
      active = !active;
      windowLeft = active ? 3 + Math.floor(rng() * 5) : 8 + Math.floor(rng() * 16);
    }
    drift();
    server.progress(frame++ * TICK_MS, TICK_MS);
    flush(s2c, clientEp, true);
    if (active) {
      now += TICK_MS;
      client.apply(now);
      client.send();
    } else if (rng() < 0.15) {
      client.send(); // throttled background ack
    }
    flush(c2s, serverEp, true);
    if (err) {
      return { ok: false, reason: `receive threw: ${err}` };
    }
  }

  // settle: reliable delivery, regular pulls + acks -> must converge.
  for (let i = 0; i < 50; i++) {
    server.progress(frame++ * TICK_MS, TICK_MS);
    flush(s2c, clientEp, false);
    now += TICK_MS;
    client.apply(now);
    client.send();
    flush(c2s, serverEp, false);
    if (err) {
      return { ok: false, reason: `receive threw (settle): ${err}` };
    }
  }

  const expected = new Map<EID, { x: number; y: number }>();
  for (const e of live) {
    const p = e.get(Position)!;
    expected.set(e.eid, { x: p.x, y: p.y });
  }
  const actual = new Map<EID, { x: number; y: number }>();
  for (const e of networkEntities(client)) {
    const p = e.get(Position);
    if (p) {
      actual.set(e.eid, { x: p.x, y: p.y });
    }
  }
  client.close();
  if (actual.size !== expected.size) {
    return { ok: false, reason: `entity count client=${actual.size} server=${expected.size}` };
  }
  for (const [eid, pos] of expected) {
    const got = actual.get(eid);
    if (!got) {
      return { ok: false, reason: `client missing entity ${eid}` };
    }
    if (got.x !== pos.x || got.y !== pos.y) {
      return {
        ok: false,
        reason: `entity ${eid} pos client=${JSON.stringify(got)} server=${JSON.stringify(pos)}`,
      };
    }
  }
  return { ok: true, reason: "" };
}

describe("reset storm fuzz", () => {
  for (const mode of ["drop", "reorder"] as Mode[]) {
    it(`converges the client onto server state under ${mode} loss`, () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= 80; seed++) {
        const result = runScenario(seed, mode);
        if (!result.ok) {
          failures.push(`seed ${seed}: ${result.reason}`);
        }
      }
      expect(failures, `\n${failures.slice(0, 15).join("\n")}`).toEqual([]);
    });
  }
});
