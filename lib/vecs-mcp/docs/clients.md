# Browser client targets

Inspect and change a browser's `ClientWorld` through its existing vecs connection,
without opening an agent connection to the browser.

## Install

Register your `ServerWorld` with `VecsMcpServer` as usual. The node detects actual
`ServerWorld` instances through the optional `@vworlds/vecs-server` peer; a plain
`World` gains no bridge component or RPC handler. In the browser:

```ts
import { installBridge } from "@vworlds/vecs-mcp/client";

const bridge = installBridge(clientWorld, { readOnly: false });
// Later, to stop answering bridge requests:
bridge.uninstall();
```

The `/client` entry is browser safe: it imports neither Node APIs nor the MCP SDK.
Install once per world, before or after socket attachment. It announces once on
each attachment, including reconnects, and immediately if already connected.
Announcement failures are contained when a disconnect races the reply.
`uninstall()` is idempotent, removes its connect listener and only its own RPC
handler, and prevents scheduled envelopes from executing. It does not retract a
previous announcement: the server retains the capability tag until disconnect.
Calls to an uninstalled bridge fail with the unknown-handler RPC error.

## Discover and address

`vecs_targets` includes each announced connection as:

```json
{
  "path": "node/main/connection-id",
  "kind": "client",
  "client": { "id": "connection-id", "eid": 1000, "name": "optional session name" }
}
```

`name` is omitted over JSON when the session entity is unnamed. A connected client
without the bridge is not listed. Targets are scanned on demand from
`NetworkClient` entities carrying the local `BridgeClient` tag; disconnect destroys
the entity and removes the target without separate bookkeeping. Pass the full
three-segment path to any world tool. A server world and its client count as two
targets, so omit `target` only when exactly one target exists. Errors include the
client connection segment in `hops` after the node name.

## Execution and replication

The RPC handler schedules a `setTimeout(..., 0)` macrotask after the current
`progress()` or `apply()` returns. It then executes the envelope over the client
world inline, with the same [execution semantics](./execution.md) as a local
server target: read-after-write, statically validated batches, exact completed
prefix on runtime failure, and rejection when `world.deferred` is still true.
If disposal or uninstall happens before execution, the handler rejects rather
than hanging or mutating a torn-down world.

Replies leave with the next client ack. Expect roughly two frames plus transport
and ack scheduling latency; a backgrounded browser can take longer. The node
limits each forwarded call to 10 seconds, driven by server sends. A timeout does
not cancel an envelope already delivered to the browser.

Changes affect only the client replica, not the authoritative server. Subsequent
replicated snapshots overwrite networked component fields; removals and baseline
resets can remove client changes entirely. Client-local components and entities
persist until application cleanup/disposal, unless attached to replicated entities
that are reset. To make an authoritative change, address the server world instead.

`readOnly: true` on the bridge rejects mutation batches and system enable/disable;
the node's read-only policy also blocks those commands before forwarding. Reads
remain available. Installing a bridge grants the connected MCP node access to the
client world; enable it only for trusted development connections.
