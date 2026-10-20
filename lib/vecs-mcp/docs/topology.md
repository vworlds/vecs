# Nodes and links

Join or mount nodes to inspect multiple worlds through one MCP connection.

A node owns local worlds and may mount remote nodes. `join` exposes the connector's
targets to the listener: use it for a game instance joining a hub. `mount` exposes
the listener's targets to the connector: use it for a hub pulling in another node.
Both use `/link` on the same HTTP server as `/mcp`; neither installs world hooks
or performs work per tick. See [security](./security.md) before linking hosts.

```ts
import { World } from "@vworlds/vecs";
import { VecsMcpServer } from "@vworlds/vecs-mcp";

const hub = new VecsMcpServer({ name: "hub" });
const port = await hub.listen(0);
const game = new VecsMcpServer({ name: "feat-x" });
game.registerWorld(new World(), "main");
const link = game.join(`ws://127.0.0.1:${port}/link`);
// The hub discovers feat-x/main after the asynchronous handshake.
// To pull instead: hub.mount("ws://qa-box:4000/link").
link.close(); // stop this link and its reconnect attempts
await game.close();
await hub.close();
```

## Paths and discovery

Call `vecs_targets` on your MCP node. Its `{ node, targets }` result includes local
worlds and each mounted peer's last advertised table. Every target has `path`,
`kind`, optional `world` counts, originating `node` metadata (`name`, `nodeId`,
`pid`, `cwd`, `branch`, `sha`), and `via` (traversed node IDs). Discovery is local:
it does not fan out. Remote counts reflect the last advertisement, not live ticks.

A directly mounted game's path is `game/main`. If `middle` mounts that game and
the hub mounts `middle`, the hub sees `middle/game/main`. At each hop, routing
removes the exposing node's prefix before selecting the next destination. Local
paths remain `node/world`. Omit `target` only when the whole aggregate has exactly
one path; otherwise the error lists local and remote alternatives.

Local names and mounted peer names must be unique within each node. A duplicate
mount is rejected during the handshake; existing peers are not replaced. A pair
of nodes may mount each other. Each advertisement carries traversal IDs; a node
drops entries containing its own ID, preventing reflected paths and routing loops.
IDs identify node lifetimes, not stable instance names.

## Lifecycle and latency

`join(url)` and `mount(url)` return a `Link` immediately. Its `state` is
`connecting`, `handshake`, `linked`, `backoff` or `closed`. Invalid URLs and schemes
other than `ws:`/`wss:` throw synchronously from `join`/`mount`. Connection failures,
authentication failures and name collisions do not throw; they retry with
jittered exponential backoff from 1 s up to 30 s. `link.close()` permanently stops
that link; `server.close()` stops all links and the listener. A join-only node
need not call `listen` unless it also needs inbound MCP or links.

Advertisements replace the whole previous table after the handshake, world
registration, a bridged client announcement/disconnect or a peer change. Topology
changes coalesce into one rebuild per `setImmediate` macrotask, outside the world's
tick and command drain; exposing links share that rebuilt table. Without an
exposing link, changes schedule no rebuild. Bridged clients are indexed by connection
ID, and component counts use a retained `ComponentDef` query rather than an entity
scan. `close()` releases that registry query.

A closed transport removes its local subtree immediately; the replacement table
propagates to exposing links on the next macrotask.
Reconnection advertises again. On idle links, the listener sends JSON `ping` frames
every 15 s; either side answers a JSON `ping` with `pong`. Each side checks for
45 s without an inbound frame and closes the socket, so the native Node 24 connector
also detects a dead listener without waiting for a TCP close. Advertisements,
requests and responses count as liveness; recent traffic suppresses needless pings.

Every tool request crosses each hop once and waits for its response. Each forwarded
request has a 30 s timeout. Errors preserve their `code` and `message`, and each
router prepends its name to `hops`. A timeout does **not** cancel work already
running remotely: never blindly retry a mutation after an ambiguous transport
failure. No commands are queued for replay after reconnect.

## Wire protocol

Frames are JSON text objects discriminated by `type`. The connector sends
`hello` with `protocol: 1`, `role: "join" | "mount"`, `name`, `nodeId` and optional
`token`. The listener returns `welcome` with `name` and `nodeId`, or `reject` with
`reason` and closes. The exposing side sends `advertise` with `node` and `targets`;
the mounting side sends `request` with `id`, `target`, `command` and `params`.
The exposing side returns `response` with the same `id` and exactly one of
`result` or `error: { code, message, hops }`. Invalid shapes, binary frames,
unexpected handshake order and wrong-direction frames close the link.
Both sides also accept `{ type: "ping" }` and `{ type: "pong" }` liveness frames.

See `src/links/link.ts` for the shared state machine and `src/links/listener.ts`
for upgrades. The listener uses `ws`; connectors use Node's global WebSocket.
