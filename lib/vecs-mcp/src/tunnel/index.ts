import type { World } from "@vworlds/vecs";
import { BRIDGE_ANNOUNCE_RPC_ID, BRIDGE_CALL_RPC_ID } from "@vworlds/vecs-protocol";
import type { ServerWorld } from "@vworlds/vecs-server";
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

/** @internal Install per-connection topology hooks only on actual ServerWorld instances. */
export function registerTunnel(
  world: World,
  changed: () => void
): { world: ServerWorld; close: () => void } | undefined {
  if (!server || !(world instanceof server.ServerWorld)) {
    return undefined;
  }
  const component = world.component(BridgeClient);
  component.on("add", changed).on("remove", changed);
  const off = world.handleRpc(BRIDGE_ANNOUNCE_RPC_ID, (_params, _request, ctx) => {
    ctx.caller.add(BridgeClient);
  });
  return {
    world,
    close: () => {
      component.off("add", changed).off("remove", changed);
      off();
    },
  };
}

/** @internal Scan on demand; no per-frame client-target bookkeeping. */
export function clientTargets(
  world: ServerWorld
): { id: string; eid: number; name: string | undefined }[] {
  const clients: { id: string; eid: number; name: string | undefined }[] = [];
  const NetworkClient = server!.NetworkClient;
  world.filter([NetworkClient, BridgeClient]).forEach([NetworkClient], (entity, [client]) => {
    clients.push({ id: client.id, eid: entity.eid, name: entity.name });
  });
  return clients;
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
