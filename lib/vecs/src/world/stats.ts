import type { System } from "../system.js";

/** Accumulated synchronous execution time, in milliseconds, since the last reset. */
export interface Timing {
  /** Number of admitted executions (not entity callbacks). */
  runs: number;
  /** Sum of execution durations in milliseconds. */
  totalMs: number;
  /** Longest execution duration in milliseconds. */
  maxMs: number;
}

/** A system's timing; read its identity and cadence from the original system. */
export interface SystemTiming extends Timing {
  /** The original system, not a descriptor copy. */
  system: System;
}

/** A named timing breakdown supplied by a world extension. */
export interface OperationTiming extends Timing {
  /** Stable operation name, for example `replication:encode`. */
  name: string;
}

/** Opt-in world timing. Reading allocates snapshots; ticking reuses slots. */
export class WorldStats {
  private _enabled = false;
  private readonly _systems = new WeakMap<System, SystemTiming & { generation: number }>();
  private readonly _operations = new Map<string, OperationTiming>();
  private _generation = 0;

  /** @internal Constructed by the owning world. */
  public constructor(private readonly _pipeline: () => readonly System[]) {}

  /** Whether system and extension timing is enabled. Off by default. */
  public get systemsEnabled(): boolean {
    return this._enabled;
  }

  /** Stop measuring without discarding accumulated results. */
  public disableSystems(): void {
    this._enabled = false;
  }

  /** Start measuring systems and extension operations on subsequent ticks. */
  public enableSystems(): void {
    this._enabled = true;
  }

  /** Read extension-operation snapshots in first-seen order; empty before measurement. */
  public operations(): OperationTiming[] {
    return Array.from(this._operations.values(), (slot) => ({ ...slot }));
  }

  /**
   * Record one completed extension operation, reusing its first-seen named slot.
   * World extensions select their instrumented path with `systemsEnabled` once
   * per frame, then call this method with a finite, non-negative duration in ms.
   * This method neither reads a clock nor checks the switch again, so an in-flight
   * measured frame can finish even if a callback changes the switch.
   * Throws `RangeError` for a negative or non-finite duration.
   */
  public recordOperation(name: string, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("operation duration must be finite and non-negative");
    }
    this._record(this._operationSlot(name), elapsedMs);
  }

  /** Clear all system and operation totals without changing the enabled state. */
  public resetSystems(): void {
    this._generation++;
    for (const slot of this._operations.values()) {
      this._clear(slot);
    }
  }

  /** Read system snapshots in current pipeline order, including zero-run systems. */
  public systems(): SystemTiming[] {
    return this._pipeline().map((system) => {
      const { runs, totalMs, maxMs } = this._systemSlot(system);
      return { system, runs, totalMs, maxMs };
    });
  }

  /** @internal Reuse a slot after the system's first measured or read appearance. */
  public _systemSlot(system: System): SystemTiming {
    let slot = this._systems.get(system);
    if (!slot) {
      slot = { system, runs: 0, totalMs: 0, maxMs: 0, generation: this._generation };
      this._systems.set(system, slot);
    }
    if (slot.generation !== this._generation) {
      this._clear(slot);
      slot.generation = this._generation;
    }
    return slot;
  }

  /** @internal Aggregate a completed execution without allocating. */
  public _record(slot: Timing, elapsedMs: number): void {
    slot.runs++;
    slot.totalMs += elapsedMs;
    slot.maxMs = Math.max(slot.maxMs, elapsedMs);
  }

  private _clear(slot: Timing): void {
    slot.runs = 0;
    slot.totalMs = 0;
    slot.maxMs = 0;
  }

  private _operationSlot(name: string): OperationTiming {
    let slot = this._operations.get(name);
    if (!slot) {
      slot = { name, runs: 0, totalMs: 0, maxMs: 0 };
      this._operations.set(name, slot);
    }
    return slot;
  }
}
