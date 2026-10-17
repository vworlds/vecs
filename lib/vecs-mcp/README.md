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

Nothing runs per tick: tools perform pull-only reads or synchronous writes between
ticks. The browser-safe `/client` entry exports `installBridge` to reach a
`ClientWorld` through its server connection; see [browser clients](./docs/clients.md).
Client execution runs on a macrotask after the current tick.
[Join or mount nodes](./docs/topology.md) to aggregate worlds through one
hub; the [hub CLI](./docs/getting-started.md#hub-cli) is included as `vecs-mcp`.
Watches are separate work.

Start with the [documentation map](./docs/README.md).

**Never expose a public port without a token.** MCP mutation access is authoritative
game access; see [security](./docs/security.md).
