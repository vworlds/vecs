import type { Entity, World } from "@vworlds/vecs";
import { BRIDGE_ANNOUNCE_RPC_ID, BRIDGE_CALL_RPC_ID } from "@vworlds/vecs-protocol";
import type { ServerRPCContext, ServerWorld } from "@vworlds/vecs-server";
import type { RPCHandler } from "@vworlds/vecs-protocol";
import { BridgeError, type BridgeRequest, type BridgeResponse } from "../bridge/router.js";

// The node entry works without the optional server peer when only plain worlds are used.
const server = await import("@vworlds/vecs-server").catch((error: unknown) => {
  if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
    return undefined;
  }
  throw error;
});

/** @internal Local-only capability tag; connection entity destruction removes the target. */
export class BridgeClient {}

/** @internal Registration-owned client index, maintained only by bridge lifecycle hooks. */
export interface Tunnel {
  world: ServerWorld;
  clients: Map<string, Entity>;
}

/** @internal Install per-connection topology hooks only on actual ServerWorld instances. */
export function registerTunnel(
  world: World,
  changed: () => void
): (Tunnel & { close: () => void }) | undefined {
  if (!server || !(world instanceof server.ServerWorld)) {
    return undefined;
  }
  const clients: Tunnel["clients"] = new Map();
  const connections = new WeakMap<Entity, string>();
  const NetworkClient = server.NetworkClient;
  const add = (entity: Entity): void => {
    const client = entity.get(NetworkClient);
    if (client) {
      connections.set(entity, client.id);
      clients.set(client.id, entity);
      changed();
    }
  };
  const remove = (entity: Entity): void => {
    // NetworkClient may already have been removed during connection destruction.
    const id = connections.get(entity);
    connections.delete(entity);
    if (id !== undefined && clients.get(id)?.eid === entity.eid) {
      clients.delete(id);
      changed();
    }
  };
  world.component(BridgeClient).on("add", add).on("remove", remove);
  // Re-registration and aliases must include clients that announced earlier.
  const existing = world.query("vecs-mcp.clients").with(NetworkClient, BridgeClient).build();
  existing.forEach(add);
  existing.destroy();
  const handler: RPCHandler<ServerRPCContext> = (_params, _request, ctx) => {
    ctx.caller.add(BridgeClient);
  };
  world.handleRpc(BRIDGE_ANNOUNCE_RPC_ID, handler);
  return {
    world,
    clients,
    close: () => {
      world.component(BridgeClient).off("add", add).off("remove", remove);
      world.unhandleRpc(BRIDGE_ANNOUNCE_RPC_ID, handler);
    },
  };
}

/** @internal Forward one envelope with a bounded wait and client-segment error attribution. */
export async function dispatchClient(
  world: ServerWorld,
  segment: string,
  request: BridgeRequest
): Promise<unknown> {
  try {
    const [response] = (await world.invoke(segment, BRIDGE_CALL_RPC_ID, [request], 10_000)) as [
      BridgeResponse,
    ];
    if ("error" in response) {
      throw new BridgeError({ ...response.error, hops: [...response.error.hops, segment] });
    }
    return response.result;
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError({
      code: "VECS_ERROR",
      message: error instanceof Error ? error.message : String(error),
      hops: [segment],
    });
  }
}
