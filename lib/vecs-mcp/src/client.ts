import type { ClientWorld } from "@vworlds/vecs-client";
import { RPC_CLOSED_CODE, RPCError, type RPCHandler } from "@vworlds/vecs-protocol";
import { LocalWorld } from "./bridge/world.js";
import type { BridgeRequest, BridgeResponse } from "./bridge/router.js";

/** Browser bridge policy, independent of the node's own read-only policy. */
export interface BridgeOptions {
  /** Reject mutation batches and system enable/disable commands. Defaults to false. */
  readOnly?: boolean;
}

/**
 * Expose this client through its existing vecs connection. Announce once per socket
 * attachment, including an already-connected world. Execute each envelope on a
 * macrotask after progress()/apply() returns, inline with read-after-write semantics.
 * No Node imports, polling, or additional tick work. Disposal/uninstall before the
 * macrotask rejects the handler with RPC_CLOSED_CODE rather than executing it.
 * Holds a live component-definition query; uninstall releases it and is safe to repeat.
 * Uses named RPCs `vecs-mcp/announce` and `vecs-mcp/call`; both peers must use this naming scheme.
 */
export function installBridge(
  world: ClientWorld,
  options: BridgeOptions = {}
): { uninstall(): void } {
  const local = new LocalWorld(world, options.readOnly);
  let installed = true;
  const announce = (): void => {
    // A disconnect/dispose may race the reply; announcement must not leak a rejection.
    void world.invoke("vecs-mcp/announce").catch(() => {});
  };
  const handler: RPCHandler = ([input]) =>
    new Promise<BridgeResponse>((resolve, reject) => {
      setTimeout(() => {
        if (world.disposed || !installed) {
          reject(new RPCError(RPC_CLOSED_CODE, "Client bridge disposed or uninstalled"));
          return;
        }
        const request = input as BridgeRequest;
        try {
          resolve({ id: request.id, result: local.command(request.command, request.params) });
        } catch (error) {
          resolve({
            id: request?.id,
            error: {
              code: "VECS_ERROR",
              message: error instanceof Error ? error.message : String(error),
              hops: [],
            },
          });
        }
      }, 0);
    });
  world.listen("vecs-mcp/call", handler);
  world.events.on("connect", announce);
  if (world.connected) {
    announce();
  }
  return {
    uninstall(): void {
      installed = false;
      world.events.off("connect", announce);
      world.unlisten("vecs-mcp/call", handler);
      local.dispose();
    },
  };
}
