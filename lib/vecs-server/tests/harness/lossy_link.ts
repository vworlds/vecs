import type { VecsSocket } from "@vworlds/vecs-protocol";
import type { Random } from "./random.js";
import type { SimClock } from "./sim_clock.js";

/** What one direction of a link does to the packets sent over it. */
export interface LinkConditions {
  /** Base one-way latency, in milliseconds, of every packet. */
  oneWayMs: number;
  /** Probability in `[0, 1]` that a packet is lost. */
  loss: number;
  /** Probability in `[0, 1]` that a surviving packet takes extra time, so later packets overtake it. */
  reorder: number;
  /** A reordered packet is delayed by a uniform extra `[0, reorderExtraMs]`. */
  reorderExtraMs: number;
}

/** Conditions for both directions of one client's connection. */
export interface DuplexConditions {
  /** Server to client. */
  down: Partial<LinkConditions>;
  /** Client to server (the acks). */
  up: Partial<LinkConditions>;
}

/** A perfect link: no latency, no loss, no reordering. */
export const CLEAN_LINK: LinkConditions = { oneWayMs: 0, loss: 0, reorder: 0, reorderExtraMs: 0 };

/** The same conditions in both directions. */
export function symmetric(conditions: Partial<LinkConditions>): DuplexConditions {
  return { down: conditions, up: conditions };
}

/** What a link has done to its traffic so far. */
export interface LinkStats {
  /** Packets handed to the link. */
  sent: number;
  /** Packets dropped by random loss. */
  lost: number;
  /** Packets dropped because the link was blocked when they were sent or when they were due. */
  blocked: number;
  /** Packets that reached the receiver. */
  delivered: number;
}

/**
 * One direction of an unreliable, unordered datagram channel, like the WebRTC
 * data channel (`ordered: false`, `maxRetransmits: 2`) the dgram transport
 * runs over.
 *
 * Each packet is lost with probability {@link LinkConditions.loss}; a survivor
 * arrives after {@link LinkConditions.oneWayMs}, plus, with probability
 * {@link LinkConditions.reorder}, a random extra delay that lets later packets
 * overtake it. {@link LossyLink.blocked} cuts the link outright, as a network
 * partition would: packets already in flight are lost too. All randomness comes
 * from the injected generator.
 */
export class LossyLink {
  /** Current conditions; assign a new object, or `Object.assign` onto it, to change them mid-run. */
  public conditions: LinkConditions;
  /** While `true` every packet is dropped, including packets already in flight. */
  public blocked = false;
  public readonly stats: LinkStats = { sent: 0, lost: 0, blocked: 0, delivered: 0 };
  /** Called with every packet as the sender hands it over, before loss is decided. */
  public tap: ((data: Uint8Array) => void) | undefined;
  /** Called with every packet that reaches the receiver, just before it is delivered. */
  public onDeliver: ((data: Uint8Array) => void) | undefined;

  public constructor(
    private readonly _clock: SimClock,
    private readonly _random: Random,
    conditions: Partial<LinkConditions>,
    private readonly _receiver: (data: Uint8Array) => void
  ) {
    this.conditions = { ...CLEAN_LINK, ...conditions };
  }

  public send(data: Uint8Array): void {
    this.stats.sent++;
    this.tap?.(data);
    // The transport copies what it is handed: ClientWorld reuses one encode
    // buffer for every ack, so a packet still in flight must not alias it.
    const packet = data.slice();
    const { oneWayMs, loss, reorder, reorderExtraMs } = this.conditions;
    // Draw in a fixed order so changing one condition does not shift the stream.
    const lossDraw = this._random();
    const reorderDraw = this._random();
    const extraDraw = this._random();
    if (this.blocked) {
      this.stats.blocked++;
      return;
    }
    if (lossDraw < loss) {
      this.stats.lost++;
      return;
    }
    const extraMs = reorderDraw < reorder ? extraDraw * reorderExtraMs : 0;
    this._clock.schedule(this._clock.now + oneWayMs + extraMs, () => this._arrive(packet));
  }

  private _arrive(packet: Uint8Array): void {
    if (this.blocked) {
      this.stats.blocked++;
      return;
    }
    this.stats.delivered++;
    this.onDeliver?.(packet);
    this._receiver(packet);
  }
}

type SocketHandler = (arg?: unknown) => void;

/**
 * One end of a simulated connection: it implements `VecsSocket`, sends over its
 * outbound {@link LossyLink}, and hands whatever its peer's link delivers to its
 * own `receive` handlers.
 */
export class SimSocket implements VecsSocket {
  public closed = false;

  private readonly _handlers = new Map<string, SocketHandler[]>();
  private _outbound: LossyLink | undefined;
  private _peer: SimSocket | undefined;

  public constructor(
    public readonly id: string,
    private readonly _clock: SimClock
  ) {}

  /** Wire this socket's outgoing traffic to `link`, with `peer` at the other end. */
  public connect(link: LossyLink, peer: SimSocket): void {
    this._outbound = link;
    this._peer = peer;
  }

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    if (this.closed) {
      return;
    }
    this._outbound?.send(data);
  }

  /** Hand a delivered packet to the `receive` handlers. */
  public receive(data: Uint8Array): void {
    if (this.closed) {
      return;
    }
    this._emit("receive", data);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._emit("disconnect");
    const peer = this._peer;
    if (peer !== undefined && !peer.closed) {
      const delayMs = this._outbound?.conditions.oneWayMs ?? 0;
      this._clock.schedule(this._clock.now + delayMs, () => peer._remoteClosed());
    }
  }

  private _emit(event: string, arg?: unknown): void {
    this._handlers.get(event)?.forEach((handler) => handler(arg));
  }

  private _remoteClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._emit("disconnect");
  }
}
