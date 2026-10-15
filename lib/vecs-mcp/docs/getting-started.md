# Getting started

Expose a local world and connect Claude Code over Streamable HTTP.

Install `@vworlds/vecs-mcp` alongside vecs. Create a `VecsMcpServer`, register worlds
and explicitly call `listen`; the package does not start anything on import.
See the [minimal example](../README.md).

```bash
claude mcp add --transport http vecs http://127.0.0.1:3210/mcp \
  --header "Authorization: Bearer development-secret"
```

The default node name is `<hostname>-<pid>`. Set `name` to a branch or instance
label when you need a stable prefix. Node and world names must be nonempty single
path segments. `registerWorld(world, name?)` uses the world's `name` if it has one,
otherwise `world`. Duplicate world names throw. Targets are `<node>/<world>`.
Call `vecs_targets` to discover paths. Omit `target` only when exactly one exists;
otherwise the error lists available paths.

`listen(port, host = "127.0.0.1")` resolves to the bound port; port `0` requests an
ephemeral port for tests. `close()` shuts down transports and the listener and is
safe to call repeatedly. Process metadata (`name`, `pid`, `cwd`, git `branch` and
`sha`) is captured once at construction. Unavailable git values are `null`.

## Demo server

From the repo root, opt in with a free non-default port:

```bash
VECS_MCP_PORT=3210 npm run dev -w @vworlds/vecs-demo-server
```

The demo registers its `main` world on loopback. With `VECS_MCP_PORT` unset, no
MCP listener is constructed and the tick loop is unchanged. `Ball.radius`,
`Player.score` and `Electron.angle`/`speed` illustrate decorators; the score
validator rejects scores over the demo limit. A radius is spawn metadata, not a
request to rebuild an existing physics body.

The demo's MCP listener has no token and is intended for local development only.
For access from another host, create a token-protected server as described in
[security](./security.md).
