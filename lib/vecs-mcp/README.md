# @vworlds/vecs-mcp

Inspect and mutate registered vecs worlds and their opted-in browser clients with an MCP agent.

The Node entry exports `VecsMcpServer`, `Link` and their configuration/state types. The isomorphic `/schema` entry exports
`field`, `describe`, `componentSchema`, `validateSet`, `FieldSpec` and `ComponentSchema`;
it imports only vecs and vecs-wire, never Node, the MCP SDK or zod.

```ts
import { World } from "@vworlds/vecs";
import { VecsMcpServer } from "@vworlds/vecs-mcp";

const world = new World();
const mcp = new VecsMcpServer({ name: "local", token: "development-secret" });
mcp.registerWorld(world);
await mcp.listen(3210); // http://127.0.0.1:3210/mcp
// Later: await mcp.close();
```

Nothing runs per tick: tools perform reads or synchronous writes between ticks.
[Watches](./docs/watches.md) add session-owned reactive logs and subscribable local
resources. Without watches, no watch queries or component hooks are registered.
The browser-safe `/client` entry exports `installBridge` to reach a
`ClientWorld` through its server connection; see [browser clients](./docs/clients.md).
Client execution runs on a macrotask after the current tick.
[Join or mount nodes](./docs/topology.md) to aggregate worlds through one
hub; the [hub CLI](./docs/getting-started.md#hub-cli) is included as `vecs-mcp`.

Start with the [documentation map](./docs/README.md).
See [getting started](./docs/getting-started.md) for world unregistration, shutdown
and MCP session limits.

**SECURITY:** Use tokenless nodes only on trusted private networks. Browser pages
can reach loopback; `/link` rejects requests carrying an `Origin` by default
(`linkOrigins` can allow trusted origins). Non-browser peers can omit or forge
Origin, so this filter is not authentication. **Never expose a public port without
a token.** MCP mutation access is authoritative game access; review
[security](./docs/security.md) before changing this deployment boundary.
