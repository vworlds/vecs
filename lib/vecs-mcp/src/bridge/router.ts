import { World } from "@vworlds/vecs";
import { LocalWorld } from "./world.js";
import type { ServerWorld } from "@vworlds/vecs-server";
import { registerTunnel, clientTargets, dispatchClient } from "../tunnel/index.js";
import { randomUUID } from "node:crypto";

/** @internal An advertised target, including its originating node and traversal history. */
export interface TargetEntry {
  path: string;
  kind: string;
  world?: Record<string, unknown>;
  client?: { id: string; eid: number; name?: string };
  node: Record<string, unknown> & { name: string; nodeId: string };
  via: string[];
}

/** @internal A whole-table replacement sent by an exposing link. */
export interface TargetTable {
  node: Record<string, unknown> & { name: string; nodeId: string };
  targets: TargetEntry[];
}

/** @internal A forwarding failure with preserved remote code and hops. */
export class BridgeError extends Error {
  public constructor(public readonly detail: { code: string; message: string; hops: string[] }) {
    super(detail.message);
  }
}

/** @internal Shared request envelope for local and future remote targets. */
export interface BridgeRequest {
  id: string;
  target?: string;
  command: string;
  params: Record<string, unknown>;
}
/** @internal Shared response envelope; hops records the nodes traversed. */
export type BridgeResponse =
  | { id: string; result: unknown }
  | { id: string; error: { code: string; message: string; hops: string[] } };
/** @internal A first-path-segment routing destination, extensible to peers. */
export interface Destination {
  paths(): string[];
  dispatch(request: BridgeRequest): unknown | Promise<unknown>;
  targets?(): TargetEntry[];
}

/** @internal Command routing; worlds install reactive hooks only for explicitly requested watches. */
export class Router {
  public readonly destinations = new Map<string, Destination>();
  public readonly worlds = new Map<string, LocalWorld>();
  public readonly nodeId = randomUUID();
  private readonly _tunnels = new Map<string, ServerWorld>();
  private readonly _cleanup = new Map<string, () => void>();
  private readonly _changes = new Set<() => void>();

  public constructor(
    public readonly name: string,
    public readonly node: Record<string, unknown>,
    private readonly readOnly = false
  ) {
    this.destinations.set(name, {
      paths: () =>
        [...this.worlds.keys()].flatMap((world) => [
          `${name}/${world}`,
          ...this._clients(world).map((client) => `${name}/${world}/${client.id}`),
        ]),
      dispatch: (request) => {
        const segments = request.target!.split("/");
        const local = this.worlds.get(segments[1]);
        if (!local || (segments.length !== 2 && segments.length !== 3)) {
          throw new Error(`Unknown target ${request.target}`);
        }
        if (segments.length === 3) {
          const tunnel = this._tunnels.get(segments[1]);
          if (!tunnel || !this._clients(segments[1]).some((client) => client.id === segments[2])) {
            throw new Error(`Unknown target ${request.target}`);
          }
          if (
            this.readOnly &&
            (request.command === "vecs_mutate" ||
              (request.command === "vecs_systems" &&
                (request.params.enable !== undefined || request.params.disable !== undefined)))
          ) {
            throw new Error("readOnly server: client mutations are forbidden");
          }
          return dispatchClient(tunnel, segments[2], request);
        }
        return local.command(request.command, request.params);
      },
    });
  }

  public register(world: World, name: string): void {
    if (!name || name.includes("/")) {
      throw new Error("World name must be a nonempty path segment");
    }
    if (this.worlds.has(name)) {
      throw new Error(`Duplicate world ${name}`);
    }
    this.worlds.set(name, new LocalWorld(world, this.readOnly));
    const tunnel = registerTunnel(world, () => this.changed());
    if (tunnel) {
      this._tunnels.set(name, tunnel.world);
      this._cleanup.set(name, tunnel.close);
    }
    this.changed();
  }

  /** Remove a local world's hooks, tunnel handler and watches; absent worlds are a no-op. */
  public unregister(world: World): void {
    for (const [name, local] of this.worlds) {
      if (local.world !== world) {
        continue;
      }
      this._cleanup.get(name)?.();
      this._cleanup.delete(name);
      this._tunnels.delete(name);
      local.watches.dispose();
      this.worlds.delete(name);
      this.changed();
    }
  }

  /** Subscribe to topology changes; the returned function removes the subscription. */
  public onChange(callback: () => void): () => void {
    this._changes.add(callback);
    return () => this._changes.delete(callback);
  }

  /** Notify exposing links after a world, bridged client, or peer table changes. */
  public changed(): void {
    for (const callback of this._changes) {
      callback();
    }
  }

  /** Read the cached aggregate table without remote requests. */
  public table(): TargetTable {
    return {
      node: { ...this.node, name: this.name, nodeId: this.nodeId },
      targets: [
        ...[...this.worlds].flatMap(([name, local]): TargetEntry[] => [
          {
            path: `${this.name}/${name}`,
            kind: "world",
            world: { name, ...local.counts() },
            node: { ...this.node, name: this.name, nodeId: this.nodeId },
            via: [this.nodeId],
          },
          ...this._clients(name).map((client) => ({
            path: `${this.name}/${name}/${client.id}`,
            kind: "client",
            client,
            node: { ...this.node, name: this.name, nodeId: this.nodeId },
            via: [this.nodeId],
          })),
        ]),
        ...[...this.destinations.values()].flatMap((destination) => destination.targets?.() ?? []),
      ],
    };
  }

  public async dispatch(request: BridgeRequest): Promise<BridgeResponse> {
    try {
      if (request.command === "vecs_targets") {
        return {
          id: request.id,
          result: this.table(),
        };
      }
      const paths = [...this.destinations.values()].flatMap((destination) => destination.paths());
      const target = request.target ?? (paths.length === 1 ? paths[0] : undefined);
      if (!target) {
        throw new Error(`Specify target; available targets: ${paths.join(", ") || "(none)"}`);
      }
      const destination = this.destinations.get(target.split("/")[0]);
      if (!destination) {
        throw new Error(`Unknown target ${target}; available targets: ${paths.join(", ")}`);
      }
      return { id: request.id, result: await destination.dispatch({ ...request, target }) };
    } catch (error) {
      return {
        id: request.id,
        error: {
          code: error instanceof BridgeError ? error.detail.code : "VECS_ERROR",
          message: error instanceof Error ? error.message : String(error),
          hops: [this.name, ...(error instanceof BridgeError ? error.detail.hops : [])],
        },
      };
    }
  }

  private _clients(name: string): ReturnType<typeof clientTargets> {
    const world = this._tunnels.get(name);
    return world ? clientTargets(world) : [];
  }
}
