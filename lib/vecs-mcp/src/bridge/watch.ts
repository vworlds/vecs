import type { Component, Entity, Query, World } from "@vworlds/vecs";
import { componentValue } from "./serialize.js";
import { query } from "./world.js";

/** @internal Thirty minutes without an event read expires a watch. */
export const WATCH_IDLE_MS = 30 * 60 * 1000;

/** @internal Immutable serialized event, in synchronous callback delivery order. */
export interface WatchEvent {
  seq: number;
  kind: "enter" | "update" | "exit";
  eid: number;
  name?: string;
  component?: string;
  value?: unknown;
}

interface Watch {
  owner: string;
  query: Query;
  events: WatchEvent[];
  start: number;
  size: number;
  capacity: number;
  latest: number;
  dropped: number;
  timer: ReturnType<typeof setTimeout>;
  hooks: { component: Component; handler: (entity: Entity, value: object) => void }[];
}

/** @internal Per-world bounded reactive logs; no tick work or hooks without watches. */
export class WatchSet {
  private readonly _watches = new Map<string, Watch>();
  private readonly _expired = new Map<string, string>();
  private readonly _listeners = new Set<(id: string) => void>();

  public constructor(private readonly world: World) {}

  /** Create one membership query and removable hooks only for projected components. */
  public create(params: Record<string, unknown>, registry: Map<string, Component>): unknown {
    const owner = this._owner(params);
    const where = query(params.where, registry);
    const include = params.include ?? [];
    if (
      !Array.isArray(include) ||
      include.some((name) => typeof name !== "string" || !registry.has(name))
    ) {
      throw new Error("include must contain registered component names");
    }
    const capacity = integer(params.maxEvents ?? 1000, "maxEvents", 1);
    if (this.world.deferred) {
      throw new Error("Create watches between ticks, not in a deferred scope");
    }
    if (this._watches.size >= 32) {
      throw new Error(`Watch cap (32); live ids: ${[...this._watches.keys()].join(", ")}`);
    }
    const id = globalThis.crypto.randomUUID();
    let ready = false;
    const selected = [...new Set(include as string[])].map(
      (name) => [name, registry.get(name)!] as const
    );
    const q = this.world
      .query(`vecs-mcp:watch:${id}`)
      .with(where)
      .enter((entity) => {
        if (!ready) {
          return;
        }
        const value = Object.fromEntries(
          selected
            .filter(([, c]) => entity.has(c))
            .map(([name, c]) => [name, componentValue(c, entity.get(c)!)])
        );
        this._append(id, {
          seq: 0,
          kind: "enter",
          eid: entity.eid,
          name: entity.name,
          ...(selected.length ? { value } : {}),
        });
      })
      .exit((entity) => {
        if (ready) {
          this._append(id, { seq: 0, kind: "exit", eid: entity.eid, name: entity.name });
        }
      });
    try {
      q.build();
      const watch: Watch = {
        owner,
        query: q,
        events: [],
        start: 0,
        size: 0,
        capacity,
        latest: 0,
        dropped: 0,
        timer: this._timer(id),
        hooks: [],
      };
      this._watches.set(id, watch);
      for (const [name, component] of selected) {
        const handler = (entity: Entity, value: object) => {
          if (q.has(entity)) {
            this._append(id, {
              seq: 0,
              kind: "update",
              eid: entity.eid,
              name: entity.name,
              component: name,
              value: componentValue(component, value),
            });
          }
        };
        component.on("set", handler);
        watch.hooks.push({ component, handler });
      }
      ready = true;
      return { watch: id, members: q.count };
    } catch (error) {
      this._destroy(id);
      q.destroy();
      throw error;
    }
  }

  /** Read oldest-first events after a cursor, refreshing only this watch's idle deadline. */
  public read(params: Record<string, unknown>): {
    events: WatchEvent[];
    latest: number;
    dropped: number;
  } {
    const owner = this._owner(params);
    const id = String(params.watch);
    const since = integer(params.since ?? 0, "since");
    const limit = integer(params.limit ?? 100, "limit");
    if (this._expired.get(id) === owner) {
      this._expired.delete(id);
      return { events: [], latest: 0, dropped: -1 };
    }
    const watch = this._get(id, owner);
    clearTimeout(watch.timer);
    watch.timer = this._timer(id);
    const events: WatchEvent[] = [];
    for (let i = 0; i < watch.size && events.length < limit; i++) {
      const event = watch.events[(watch.start + i) % watch.capacity];
      if (event.seq > since) {
        events.push(event);
      }
    }
    return { events, latest: watch.latest, dropped: watch.dropped };
  }

  /** Destroy the owned query and remove exactly its hooks. */
  public remove(params: Record<string, unknown>): { watch: string } {
    const id = String(params.watch);
    this._get(id, this._owner(params));
    this._destroy(id);
    return { watch: id };
  }

  /** Release live watches and expiry receipts when an owning session closes. */
  public close(owner: string): void {
    for (const [id, watch] of this._watches) {
      if (watch.owner === owner) {
        this._destroy(id);
      }
    }
    for (const [id, session] of this._expired) {
      if (session === owner) {
        this._expired.delete(id);
      }
    }
  }

  /** List only the calling session's live watches. */
  public ids(owner: string): string[] {
    return [...this._watches].filter(([, watch]) => watch.owner === owner).map(([id]) => id);
  }

  /** Check ownership without refreshing a watch, optionally including its unread expiry receipt. */
  public owns(id: string, owner: string, expired = false): boolean {
    return this._watches.get(id)?.owner === owner || (expired && this._expired.get(id) === owner);
  }

  /** Observe appended events; the caller coalesces notifications outside ECS routing. */
  public listen(listener: (id: string) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _append(id: string, event: WatchEvent): void {
    const watch = this._watches.get(id);
    if (!watch) {
      return;
    }
    event.seq = ++watch.latest;
    if (watch.size === watch.capacity) {
      watch.events[watch.start] = event;
      watch.start = (watch.start + 1) % watch.capacity;
      watch.dropped++;
    } else {
      watch.events[(watch.start + watch.size++) % watch.capacity] = event;
    }
    for (const listener of this._listeners) {
      listener(id);
    }
  }

  private _destroy(id: string): void {
    const watch = this._watches.get(id);
    if (!watch) {
      return;
    }
    this._watches.delete(id);
    clearTimeout(watch.timer);
    for (const { component, handler } of watch.hooks) {
      component.off("set", handler);
    }
    watch.query.destroy();
  }

  private _get(id: string, owner: string): Watch {
    const watch = this._watches.get(id);
    if (!watch || watch.owner !== owner) {
      throw new Error(`Unknown watch ${id}`);
    }
    return watch;
  }

  private _owner(params: Record<string, unknown>): string {
    if (typeof params._session !== "string" || !params._session) {
      throw new Error("Watch requires an MCP session");
    }
    return params._session;
  }

  private _timer(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const watch = this._watches.get(id);
      if (watch) {
        this._expired.set(id, watch.owner);
        this._destroy(id);
      }
    }, WATCH_IDLE_MS);
    // LocalWorld is also used by browser tunnels, whose timers are numeric.
    timer.unref?.();
    return timer;
  }
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value as number;
}
