import { World } from "@vworlds/vecs";
import { LocalWorld } from "./world.js";
import type { ServerWorld } from "@vworlds/vecs-server";
import { registerTunnel, clientTargets, dispatchClient, TunnelError } from "../tunnel/index.js";

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
}

/** @internal Pull-only routing; no tick hooks or live queries. */
export class Router {
  public readonly destinations = new Map<string, Destination>();
  public readonly worlds = new Map<string, LocalWorld>();
  private readonly _tunnels = new Map<string, ServerWorld>();

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
    const tunnel = registerTunnel(world);
    if (tunnel) {
      this._tunnels.set(name, tunnel);
    }
  }

  public async dispatch(request: BridgeRequest): Promise<BridgeResponse> {
    try {
      if (request.command === "vecs_targets") {
        return {
          id: request.id,
          result: {
            node: this.node,
            targets: [...this.worlds].flatMap(([name, local]) => [
              {
                path: `${this.name}/${name}`,
                kind: "world",
                world: { name, ...local.counts() },
              },
              ...this._clients(name).map((client) => ({
                path: `${this.name}/${name}/${client.id}`,
                kind: "client",
                client,
              })),
            ]),
          },
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
          code: error instanceof TunnelError ? error.detail.code : "VECS_ERROR",
          message: error instanceof Error ? error.message : String(error),
          hops: [this.name, ...(error instanceof TunnelError ? error.detail.hops : [])],
        },
      };
    }
  }

  private _clients(name: string): ReturnType<typeof clientTargets> {
    const world = this._tunnels.get(name);
    return world ? clientTargets(world) : [];
  }
}
