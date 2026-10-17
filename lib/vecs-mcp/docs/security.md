# Security

Limit authoritative inspection access to trusted local development agents.

`listen` binds `127.0.0.1` by default. **Never expose a public port without a
token.** Pass `{ token: "..." }` to require an exact `Authorization: Bearer ...`
header on every request. Use a secure tunnel or TLS reverse proxy for remote
transport; the listener itself is HTTP. Keep tokens out of source control and
agent output.

MCP session ids are not credentials: the token still gates every POST, GET and
DELETE, including requests carrying a valid session id. Watches and local
resources are owned by the creating session; other sessions cannot read, subscribe
to, or destroy them. DELETE or 30 minutes of session inactivity releases them.

The same `token` option guards `/link` handshakes using a constant-time comparison.
Connectors put their configured token in `hello`; connected nodes must therefore
share the listener's token. Without a token, anyone who can reach the port can
mount the node or join with their own targets. Trust linked peers: their metadata,
paths, schemas and component values are supplied by remote application code.
Use `wss://` with a TLS reverse proxy when crossing hosts; WebSocket JSON hello
contains the token. The CLI's `--token` is also visible in process arguments.

On `ws://`, the `hello` token crosses the network in cleartext; anyone able to
observe the traffic can read and reuse it. A link outside loopback needs `wss://`
or a trusted network. A token authenticates access but does not encrypt transport.

`{ readOnly: true }` rejects `vecs_mutate` and both `vecs_systems` controls.
It does not redact data: registered worlds, component values, process pid/cwd,
and best-effort git branch/sha remain visible. Register only worlds the agent
should inspect. Schema descriptions and component values are game-supplied data,
not instructions for an agent to follow.

Read-only nodes allow watch creation, event reads and unwatching. Apply the same
data-exposure precautions to subscribed resources as to one-shot entity reads.

Read-only world enforcement belongs to the node that owns that world; configure
`readOnly` there, not just on an aggregating hub. Joining a hub exposes all targets
the node can route, including its mounted peers. Cascades extend the trust boundary
and expose originating process/git metadata through every mounting hop.

This package does not authenticate game players or authorize individual ops.
Possession of a mutation token means authoritative game access. A validator is a
game-rule guard, not a security sandbox; constructors and hooks are trusted
application code. Opaque values reduce accidental traversal, not exposure of
all application secrets. Do not install the demo listener in production.
