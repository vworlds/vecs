import { vi, type MockInstance } from "vitest";
import { performance } from "node:perf_hooks";
import {
  Client2Server,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { ClientWorld, type ClientWorldOptions } from "@vworlds/vecs-client";
import { Decoder } from "@vworlds/vecs-wire";
import type { ComponentClass, QueryDSL, World } from "@vworlds/vecs";
import { NetworkClient, Networked, ServerWorld, View } from "../../src/index.js";
import type { ServerWorldOptions } from "../../src/index.js";
import { LossyLink, SimSocket, symmetric, type DuplexConditions } from "./lossy_link.js";
import { createRandom, deriveSeed } from "./random.js";
import { SimClock } from "./sim_clock.js";

/**
 * A loss/latency harness for replication: a real `ServerWorld` and any number of
 * real `ClientWorld`s joined by simulated unreliable links, all on one
 * deterministic virtual clock.
 *
 * What is simulated, and what is real:
 *
 * - The worlds, the wire format, the diff history and the client's diff buffer
 *   are the production code. Only the transport is fake.
 * - Each client has a {@link LossyLink} per direction with its own one-way
 *   delay, loss probability and reordering (a random extra delay that lets
 *   later packets overtake). Links can be cut and restored mid-run.
 * - Time is virtual. `performance.now()` is mocked to the {@link SimClock}, so
 *   the server's `send()` sees the simulated time, and the harness drives every
 *   timer itself: the server tick, each client's ack interval and each client's
 *   render loop. The clients' own ack timer is disabled for that reason.
 * - Every random decision comes from a generator seeded from
 *   {@link ReplicationSimOptions.seed}, so a failing run reproduces exactly.
 *
 * Each {@link SimClient} records what reached it: frames, baselines
 * (`fromFrame === 0`), `reset` events, and the enter and exit of the entities
 * it replicates, so a test can tell a delta from a tear-down and rebuild.
 *
 * ```ts
 * const sim = new ReplicationSim({ networkComponents: [Position], seed: 7 });
 * const client = sim.addClient({ link: symmetric({ oneWayMs: 100, loss: 0.05 }) });
 * sim.onTick(() => entities.forEach((e) => e.set(Position, next(e))));
 * sim.run(60_000);
 * expect(client.stats.resets).toHaveLength(1);
 * sim.dispose();
 * ```
 *
 * Call {@link ReplicationSim.dispose} when the test ends: it restores
 * `performance.now`.
 */
export class ReplicationSim {
  public readonly clock = new SimClock();
  public readonly server: ServerWorld;
  public readonly clients: SimClient[] = [];
  /** Server frames driven so far. */
  public ticks = 0;

  private readonly _seed: number;
  private readonly _options: ResolvedOptions;
  private readonly _listener = new SimListener();
  private readonly _tickHooks: Array<(tick: number) => void> = [];
  private readonly _nowSpy: MockInstance<() => number>;
  private readonly _stopTick: () => void;
  private _clientCount = 0;

  public constructor(options: ReplicationSimOptions) {
    this._seed = options.seed ?? 1;
    this._options = {
      networkComponents: options.networkComponents,
      tickMs: 1000 / (options.tickHz ?? 30),
      renderMs: 1000 / (options.renderHz ?? 60),
      ackIntervalMs: options.ackIntervalMs ?? 1000 / 30,
      link: options.link ?? symmetric({}),
      view: options.view ?? true,
    };
    this._nowSpy = vi.spyOn(performance, "now").mockImplementation(() => this.clock.now);
    this.server = new ServerWorld({
      name: "sim",
      networkComponents: options.networkComponents,
      ...options.serverOptions,
    });
    const view = this._options.view;
    this.server.component(NetworkClient).on("set", (entity) => {
      entity.set(View, { dsl: view });
    });
    this.server._attach(this._listener);
    this._stopTick = this.clock.every(this._options.tickMs, () => this._tick());
  }

  /** Server frame duration in milliseconds. */
  public get tickMs(): number {
    return this._options.tickMs;
  }

  /** Run `hook(tick)` on every server frame, just before the world progresses. */
  public onTick(hook: (tick: number) => void): void {
    this._tickHooks.push(hook);
  }

  /**
   * Connect a new client now: a fresh `ClientWorld` and a new session on the
   * (possibly long-running) server.
   *
   * @param options - Per-client link conditions and ack interval; anything
   *   omitted falls back to the simulation's defaults.
   */
  public addClient(options: SimClientOptions = {}): SimClient {
    const index = this._clientCount++;
    const client = new SimClient({
      id: `client-${index}`,
      clock: this.clock,
      seed: deriveSeed(this._seed, index),
      networkComponents: this._options.networkComponents,
      tickMs: options.serverTickIntervalMs ?? this._options.tickMs,
      renderMs: this._options.renderMs,
      ackIntervalMs: options.ackIntervalMs ?? this._options.ackIntervalMs,
      link: mergeConditions(this._options.link, options.link),
      interpolators: options.interpolators,
    });
    this.clients.push(client);
    this._listener.accept(client.serverSocket);
    return client;
  }

  /** Advance virtual time by `durationMs`, running every tick, ack, render and packet that falls due. */
  public run(durationMs: number): void {
    this.clock.runFor(durationMs);
  }

  /**
   * Compare a client's replicated state with the server's.
   *
   * @param client - The client to check.
   * @param components - The components to compare; defaults to every network component.
   * @returns One line per difference; empty when the client matches the server.
   */
  public diffFromServer(client: SimClient, components?: ComponentClass[]): string[] {
    const compared = components ?? this._options.networkComponents;
    const expected = worldState(this.server, compared, true);
    const actual = worldState(client.world, compared, false);
    const differences: string[] = [];
    expected.forEach((state, eid) => {
      const seen = actual.get(eid);
      if (seen === undefined) {
        differences.push(`entity ${eid} is missing on the client (server has ${state})`);
      } else if (seen !== state) {
        differences.push(`entity ${eid}: client has ${seen}, server has ${state}`);
      }
    });
    actual.forEach((state, eid) => {
      if (!expected.has(eid)) {
        differences.push(`entity ${eid} only exists on the client (${state})`);
      }
    });
    return differences;
  }

  /** Stop the simulation: end the tick, close the clients and restore `performance.now`. */
  public dispose(): void {
    this._stopTick();
    this.clients.forEach((client) => client.dispose());
    this._nowSpy.mockRestore();
  }

  private _tick(): void {
    const tick = this.ticks++;
    this._tickHooks.forEach((hook) => hook(tick));
    this.server.progress(this.clock.now, this._options.tickMs);
  }
}

/** Options for {@link ReplicationSim}. */
export interface ReplicationSimOptions {
  /** The replicated component classes, in wire-type order; server and every client use them. */
  networkComponents: ComponentClass[];
  /** Seed of every random decision: loss, reordering and each client's timer phases. Default `1`. */
  seed?: number;
  /** Server frames per second. Default `30`. */
  tickHz?: number;
  /** Client `progress()` calls per second. Default `60`. */
  renderHz?: number;
  /** How often a client acks, in milliseconds. Default `1000 / 30`, the `ClientWorld` default. */
  ackIntervalMs?: number;
  /** Extra options for the `ServerWorld` under test, such as `historyFrames`. */
  serverOptions?: ServerWorldOptions;
  /** Link conditions every client gets unless it overrides them. Default: a perfect link. */
  link?: DuplexConditions;
  /** The `View` every session is given, which decides what its client sees. Default `true`: everything. */
  view?: QueryDSL;
}

/** Options for {@link ReplicationSim.addClient}. */
export interface SimClientOptions {
  /** Advertised tick interval, independently of actual server scheduling; defaults to the server's. */
  serverTickIntervalMs?: number;
  /** Conditions for this client's two links; overrides the simulation's defaults field by field. */
  link?: Partial<DuplexConditions>;
  /** How often this client acks, in milliseconds. */
  ackIntervalMs?: number;
  /** Components this client interpolates between server frames; none by default, so they snap. */
  interpolators?: ClientWorldOptions["interpolators"];
}

/** One `reset` event the client emitted when it applied a baseline, with the time it did. */
export interface ResetRecord {
  atMs: number;
  /** `true` for the first baseline this client world ever applied. */
  initial: boolean;
  fromFrame: number;
  toFrame: number;
}

/** One baseline the server handed to a client's socket, with the time it did. */
export interface BaselineRecord {
  atMs: number;
  toFrame: number;
}

/** The newest frame a client had accepted moved forward to `version` at `atMs`. */
export interface VersionAdvance {
  atMs: number;
  version: number;
}

/** One delta the server handed to a client's socket: the frames it covers and when it was sent. */
export interface DeltaRecord {
  atMs: number;
  /** The frame the delta starts from, which the client must already hold. */
  fromFrame: number;
  toFrame: number;
}

/** One `disconnect` event a client emitted: the time, and the notice that explains it, if any. */
export interface DisconnectRecord {
  atMs: number;
  /** `1` (the protocol-error code) when the client closed itself over what the server sent. */
  code: number | undefined;
  reason: string | undefined;
}

/** Everything a {@link SimClient} observed. */
export interface ClientStats {
  /** Frames the server handed to this client's socket, before loss. */
  framesSent: number;
  /** Bytes of those frames, before loss. */
  bytesSent: number;
  /** Frames among them that carried the optimistic marker, a delta based past the server's ack. */
  optimisticFramesSent: number;
  /** Acks this client handed to its socket that reported a gap, before loss. */
  gapReportsSent: number;
  /**
   * Each time the newest frame this client had accepted moved forward: when, and to which frame.
   * The gaps between them are how long the client's view stood still.
   */
  versionAdvances: VersionAdvance[];
  /** Baselines (`fromFrame === 0`) the server handed to this client's socket, before loss. */
  baselinesSent: BaselineRecord[];
  /** Deltas (frames with a diff that is not a baseline) the server handed to this client's socket. */
  deltasSent: DeltaRecord[];
  /** Baselines that arrived at this client's socket, duplicates and stale ones included. */
  baselinesDelivered: number;
  /** The client's `reset` events: baselines it applied as destroy-then-rebuild. */
  resets: ResetRecord[];
  /** The client's `disconnect` events. A healthy run has none: a client that could not accept what the server sent closes itself. */
  disconnects: DisconnectRecord[];
  /** Replicated entities that entered the client world, counting each rebuild again. */
  enters: number;
  /** Replicated entities that left the client world; a rebuild shows up as a burst of these. */
  exits: number;
  /** Exceptions thrown while the client or the server handled a packet from this connection. */
  errors: string[];
}

/** One simulated client: a `ClientWorld`, its two links and what it saw. */
export class SimClient {
  public readonly id: string;
  public readonly world: ClientWorld;
  /** Server to client. */
  public readonly down: LossyLink;
  /** Client to server. */
  public readonly up: LossyLink;
  /** The server's end of the connection, handed to the listener when the client connects. */
  public readonly serverSocket: SimSocket;
  public readonly stats: ClientStats = {
    framesSent: 0,
    bytesSent: 0,
    optimisticFramesSent: 0,
    gapReportsSent: 0,
    versionAdvances: [],
    baselinesSent: [],
    deltasSent: [],
    baselinesDelivered: 0,
    resets: [],
    disconnects: [],
    enters: 0,
    exits: 0,
    errors: [],
  };

  private readonly _clock: SimClock;
  private readonly _stopTimers: Array<() => void> = [];
  private _lastVersion = -1;

  /** Use {@link ReplicationSim.addClient} to build one. */
  public constructor(config: SimClientConfig) {
    const { clock } = config;
    this.id = config.id;
    this._clock = clock;
    const phase = createRandom(deriveSeed(config.seed, 0));
    this.serverSocket = new SimSocket(config.id, clock);
    const clientSocket = new SimSocket(`${config.id}:client`, clock);
    this.down = new LossyLink(
      clock,
      createRandom(deriveSeed(config.seed, 1)),
      config.link.down,
      (data) => this._deliver(clientSocket, data, "client")
    );
    this.up = new LossyLink(
      clock,
      createRandom(deriveSeed(config.seed, 2)),
      config.link.up,
      (data) => this._deliver(this.serverSocket, data, "server")
    );
    this.serverSocket.connect(this.down, clientSocket);
    clientSocket.connect(this.up, this.serverSocket);
    this.down.tap = (data) => this._observeServerFrame(data);
    this.down.onDeliver = (data) => this._observeDelivery(data);
    this.up.tap = (data) => this._observeClientAck(data);

    // The ack timer is the harness's: a ClientWorld interval would run on real time.
    this.world = new ClientWorld({
      networkComponents: config.networkComponents,
      serverTickIntervalMs: config.tickMs,
      ackIntervalMs: DISABLED_TIMER_MS,
      interpolators: config.interpolators,
    });
    this.world.events.on("reset", (event) => {
      this.stats.resets.push({ ...event, atMs: clock.now });
    });
    this.world.events.on("disconnect", (notice) => {
      this.stats.disconnects.push({ atMs: clock.now, code: notice?.code, reason: notice?.reason });
    });
    const probe = config.networkComponents[0];
    this.world
      .query(`sim:${config.id}:replicated`)
      .with(probe)
      .enter(() => {
        this.stats.enters++;
      })
      .exit(() => {
        this.stats.exits++;
      })
      .build();
    this.world.attachSocket(clientSocket);

    const render = (): void => this.world.progress(clock.now, config.renderMs);
    this._stopTimers.push(
      clock.every(config.renderMs, render, clock.now + phase() * config.renderMs),
      clock.every(config.ackIntervalMs, () => this.world.send())
    );
  }

  /** Cut or restore one or both directions, dropping packets already in flight. */
  public setBlocked(direction: "down" | "up" | "both", blocked: boolean): void {
    if (direction !== "up") {
      this.down.blocked = blocked;
    }
    if (direction !== "down") {
      this.up.blocked = blocked;
    }
  }

  /** The number of baselines the server handed to this client's socket since `sinceMs`. */
  public baselinesSentSince(sinceMs: number): number {
    return this.stats.baselinesSent.filter((baseline) => baseline.atMs >= sinceMs).length;
  }

  /** Stop this client's timers and release its world. */
  public dispose(): void {
    this._stopTimers.forEach((stop) => stop());
    this.world.dispose();
  }

  /**
   * The newest frame the client's diff buffer has accepted, which is what it acks. The harness
   * reads it from the buffer itself: no public API of `ClientWorld` exposes it.
   */
  private get _version(): number {
    return (this.world as unknown as { _diffBuffer: { version: number } })._diffBuffer.version;
  }

  private _deliver(socket: SimSocket, data: Uint8Array, receiver: "client" | "server"): void {
    try {
      socket.receive(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stats.errors.push(`${receiver} at ${this._clock.now.toFixed(1)} ms: ${message}`);
    }
    if (receiver === "client") {
      this._noteVersion();
    }
  }

  private _noteVersion(): void {
    const version = this._version;
    if (version > this._lastVersion) {
      this.stats.versionAdvances.push({ atMs: this._clock.now, version });
    }
    this._lastVersion = version;
  }

  private _observeClientAck(data: Uint8Array): void {
    if (new Decoder(data).read(Client2Server).gap) {
      this.stats.gapReportsSent++;
    }
  }

  private _observeServerFrame(data: Uint8Array): void {
    this.stats.framesSent++;
    this.stats.bytesSent += data.length;
    const message = Server2Client.decodeWith(this.world.cid, new Decoder(data));
    if (message.optimistic) {
      this.stats.optimisticFramesSent++;
    }
    const diff = message.diff;
    if (diff === undefined) {
      return;
    }
    if (diff.fromFrame === 0) {
      this.stats.baselinesSent.push({ atMs: this._clock.now, toFrame: diff.toFrame });
    } else {
      this.stats.deltasSent.push({
        atMs: this._clock.now,
        fromFrame: diff.fromFrame,
        toFrame: diff.toFrame,
      });
    }
  }

  private _observeDelivery(data: Uint8Array): void {
    const message = Server2Client.decodeWith(this.world.cid, new Decoder(data));
    if (message.diff?.fromFrame === 0) {
      this.stats.baselinesDelivered++;
    }
  }
}

interface SimClientConfig {
  id: string;
  clock: SimClock;
  seed: number;
  networkComponents: ComponentClass[];
  tickMs: number;
  renderMs: number;
  ackIntervalMs: number;
  link: DuplexConditions;
  interpolators: ClientWorldOptions["interpolators"];
}

interface ResolvedOptions {
  networkComponents: ComponentClass[];
  tickMs: number;
  renderMs: number;
  ackIntervalMs: number;
  link: DuplexConditions;
  view: QueryDSL;
}

/** Large enough that a `ClientWorld` never fires its own ack timer, small enough for Node's 32-bit timers. */
const DISABLED_TIMER_MS = 1e9;

class SimListener implements VecsSocketListener {
  private readonly _handlers: Array<(socket: VecsSocket) => void> = [];

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

function mergeConditions(
  base: DuplexConditions,
  override: Partial<DuplexConditions> | undefined
): DuplexConditions {
  return {
    down: { ...base.down, ...override?.down },
    up: { ...base.up, ...override?.up },
  };
}

/**
 * Serialize the replicated components of every entity in a world, keyed by eid.
 * Server entities count only if they are `Networked`, since that is what
 * replicates; the client world holds nothing else.
 */
function worldState(
  world: World,
  components: ComponentClass[],
  requireNetworked: boolean
): Map<number, string> {
  const state = new Map<number, string>();
  for (const entity of world.entities.values()) {
    if (requireNetworked && entity.get(Networked) === undefined) {
      continue;
    }
    const parts: string[] = [];
    for (const Class of components) {
      const component = entity.get(Class);
      if (component !== undefined) {
        parts.push(`${Class.name}${JSON.stringify(component)}`);
      }
    }
    if (parts.length > 0) {
      state.set(entity.eid, parts.join(" "));
    }
  }
  return state;
}
