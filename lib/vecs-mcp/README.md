# @vworlds/vecs-mcp

Inspect and mutate explicitly registered local vecs worlds with an MCP agent.

The Node entry exports `VecsMcpServer`. The isomorphic `/schema` entry exports
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
Links and browser tunnels are separate work.

Start with the [documentation map](./docs/README.md).

**Never expose a public port without a token.** MCP mutation access is authoritative
game access; see [security](./docs/security.md).
