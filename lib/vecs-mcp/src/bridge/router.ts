import { World } from "@vworlds/vecs";
import { LocalWorld } from "./world.js";
import { registerTunnel, dispatchClient, type Tunnel } from "../tunnel/index.js";
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
  private readonly _tunnels = new Map<string, Tunnel>();
  private readonly _changes = new Set<(table: TargetTable) => void>();
  private _pendingChange?: ReturnType<typeof setImmediate>;

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
          if (!tunnel || !tunnel.clients.has(segments[2])) {
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
          return dispatchClient(tunnel.world, segments[2], request);
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
      this._tunnels.set(name, tunnel);
    }
    this.changed();
  }

  /** Subscribe to a shared, coalesced topology table; return an unsubscribe function. */
  public onChange(callback: (table: TargetTable) => void): () => void {
    this._changes.add(callback);
    return () => this._changes.delete(callback);
  }

  /** Coalesce topology notifications outside the tick; idle nodes schedule nothing. */
  public changed(): void {
    if (!this._changes.size || this._pendingChange) {
      return;
    }
    this._pendingChange = setImmediate(() => {
      this._pendingChange = undefined;
      if (!this._changes.size) {
        return;
      }
      const table = this.table();
      for (const callback of this._changes) {
        callback(table);
      }
    });
  }

  /** Combine current local targets and cached peer advertisements without remote requests. */
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
      const paths =
        request.target === undefined
          ? [...this.destinations.values()].flatMap((destination) => destination.paths())
          : [];
      const target = request.target ?? (paths.length === 1 ? paths[0] : undefined);
      if (!target) {
        throw new Error(`Specify target; available targets: ${paths.join(", ") || "(none)"}`);
      }
      const destination = this.destinations.get(target.split("/")[0]);
      if (!destination) {
        throw new Error(`Unknown target ${target}`);
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

  private _clients(name: string): { id: string; eid: number; name: string | undefined }[] {
    return [...(this._tunnels.get(name)?.clients ?? [])].map(([id, entity]) => ({
      id,
      eid: entity.eid,
      name: entity.name,
    }));
  }
}
