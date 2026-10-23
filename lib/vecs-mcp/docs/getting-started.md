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
ephemeral port for tests. Use `await unregisterWorld(world)` to remove a local
targets (including aliases), its bridge announcement hooks and RPC handler, and all its watches and
subscriptions. It also attempts to unwatch tunneled clients before removing their
routes. Unknown worlds are a no-op; re-registering does not stack hooks.
`await close()` unregisters every world and shuts down transports and the listener;
it is safe to repeat. Process metadata (`name`, `pid`, `cwd`, git `branch` and
`sha`) is captured once at construction. Unavailable git values are `null`.
MCP initialization advertises the node name and lazily reads the version from
vecs-mcp's package manifest on first use. Normal package-version bumps update
the handshake. If bundling relocates the entrypoint or metadata cannot be read,
the informational version is `"unknown"`; no manifest copying is required and
version discovery never prevents import or use. This fallback is expected for
the bundled demo.

## MCP sessions

Initialize once, then reuse the returned `Mcp-Session-Id` on subsequent requests;
the MCP SDK does this automatically. Each session has its own MCP server and
transport. POST keeps JSON responses; GET opens the notification stream used by
[watch subscriptions](./watches.md). DELETE closes a session and releases its
watches. Sessions also close after 30 minutes without an HTTP request; an open
GET stream alone does not keep a session alive. SDK clients should call their
transport's `terminateSession()` before closing when finished.

Each node admits at most **16 concurrent MCP sessions**, including pending
initializations. At capacity, a new initialization evicts the session idle longest
and releases its watches. An idle session has no command request in flight; an open
notification GET stream does not make it busy. If every session is busy, the new
request receives HTTP 503 with `MCP session cap (16); all sessions are busy`.
Reuse sessions rather than repeatedly initializing.

Session ids are routing identifiers, not credentials. Include the bearer token on
every request, including GET and DELETE, when the listener requires one.

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

Set `VECS_MCP_HUB=ws://127.0.0.1:4000/link` alongside `VECS_MCP_PORT` to join a
hub after the listener starts. The default hostname/pid name distinguishes demo
processes; node metadata identifies their branches. With `VECS_MCP_PORT` unset,
`VECS_MCP_HUB` alone does not create a server.

The demo's MCP listener has no token and is intended for local development only.
For access from another host, create a token-protected server as described in
[security](./security.md).

## Hub CLI

Run a hub and point Claude Code at its single MCP endpoint:

```bash
npx @vworlds/vecs-mcp hub --port 4000 --name hub
claude mcp add --transport http vecs http://127.0.0.1:4000/mcp
```

The installed binary is `vecs-mcp`. `hub` requires `--port` (0–65535) and accepts
`--host` (default `127.0.0.1`), `--name` (default `hub`), `--token`, and repeated
`--mount ws://host:port/link`. Invalid arguments print usage and exit non-zero.
SIGINT/SIGTERM shuts down the listener and connectors. Connect games with
`join`, or pull nodes with `--mount`; see [nodes and links](./topology.md).
