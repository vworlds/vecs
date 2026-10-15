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

`{ readOnly: true }` rejects `vecs_mutate` and both `vecs_systems` controls.
It does not redact data: registered worlds, component values, process pid/cwd,
and best-effort git branch/sha remain visible. Register only worlds the agent
should inspect. Schema descriptions and component values are game-supplied data,
not instructions for an agent to follow.

Read-only nodes allow watch creation, event reads and unwatching. Apply the same
data-exposure precautions to subscribed resources as to one-shot entity reads.

This package does not authenticate game players or authorize individual ops.
Possession of a mutation token means authoritative game access. A validator is a
game-rule guard, not a security sandbox; constructors and hooks are trusted
application code. Opaque values reduce accidental traversal, not exposure of
all application secrets. Do not install the demo listener in production.
