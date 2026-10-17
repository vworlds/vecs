# vecs monorepo

**vecs** is a TypeScript Entity Component System (ECS) for real-time games and simulations:
entities are numeric ids, components are plain data classes, and systems react to component
presence and change inside a phased update pipeline. This repository contains the core
`@vworlds/vecs` library and the ecosystem built on it — binary wire encoding, a client/server
replication protocol, a Box2D-derived physics engine, a Phaser rendering stack, and a demo
client/server pair.

## Start here

New to vecs? Start with the core library: **[`lib/vecs`](./lib/vecs/README.md)** and its
[documentation](./lib/vecs/docs/README.md). Deeper docs for the other libraries will follow; today
[`lib/vecs-physics/docs`](./lib/vecs-physics/docs/index.md) and the networking stack —
[`lib/vecs-protocol/docs`](./lib/vecs-protocol/docs/README.md),
[`lib/vecs-server/docs`](./lib/vecs-server/docs/README.md), and
[`lib/vecs-client/docs`](./lib/vecs-client/docs/README.md) — are documented to the same standard.

## Library map

| Package                                                   | Purpose                                                                                                           | Docs                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`@vworlds/vecs`](./lib/vecs)                             | The core ECS: worlds, entities, components, systems, queries, relationships, modules, and phases.                 | [README](./lib/vecs/README.md) · [docs](./lib/vecs/docs/README.md)                   |
| [`@vworlds/vecs-wire`](./lib/vecs-wire)                   | Binary serialization: encoder/decoder pair and the `@type` field decorator for deterministic wire messages.       | [README](./lib/vecs-wire/README.md)                                                  |
| [`@vworlds/vecs-protocol`](./lib/vecs-protocol)           | The client↔server protocol: `Server2Client` / `Client2Server` messages, state diffs, RPC, transport interfaces.   | [README](./lib/vecs-protocol/README.md) · [docs](./lib/vecs-protocol/docs/README.md) |
| [`@vworlds/vecs-server`](./lib/vecs-server)               | Node.js server runtime: `ServerWorld`, per-client views and interest management, diff history, listeners.         | [README](./lib/vecs-server/README.md) · [docs](./lib/vecs-server/docs/README.md)     |
| [`@vworlds/vecs-client`](./lib/vecs-client)               | Browser client runtime: `ClientWorld` replication, diff buffering, and component interpolation.                   | [README](./lib/vecs-client/README.md) · [docs](./lib/vecs-client/docs/README.md)     |
| [`@vworlds/vecs-physics`](./lib/vecs-physics)             | A Box2D v3 port with an idiomatic vecs API: physics as components, systems, and phases.                           | [README](./lib/vecs-physics/README.md) · [docs](./lib/vecs-physics/docs/index.md)    |
| [`@vworlds/vecs-phaser`](./lib/vecs-phaser)               | Data-only package of wire-serializable Phaser render components and the shared protocol component order.          | [README](./lib/vecs-phaser/README.md)                                                |
| [`@vworlds/vecs-phaser-server`](./lib/vecs-phaser-server) | Server-side helpers for the Phaser stack: render exclusivity wiring, shape builders, physics-to-render pose sync. | [README](./lib/vecs-phaser-server/README.md)                                         |
| [`@vworlds/vecs-phaser-client`](./lib/vecs-phaser-client) | Browser render adapter: observes a replicated `ClientWorld` and drives Phaser GameObjects automatically.          | [README](./lib/vecs-phaser-client/README.md)                                         |
| [`@vworlds/vecs-mcp`](./lib/vecs-mcp)                     | Opt-in MCP inspection and mutation of local worlds, with shared schema decorators.                                | [Docs](./lib/vecs-mcp/docs/README.md)                                                |
| [`@vworlds/vecs-demo-server`](./apps/server)              | Demo app: authoritative server owning the world, physics, interest management, and replication.                   | [README](./apps/server/README.md)                                                    |
| [`@vworlds/vecs-demo-client`](./apps/client)              | Demo app: Phaser client that connects to the demo server and renders replicated entities.                         | [README](./apps/client/README.md)                                                    |

## How the layers relate

```text
        core            @vworlds/vecs ← vecs-wire ← vecs-protocol
                              ↑                          ↑
        platform        vecs-server ──────── vecs-client
                              ↑                  ↑
        physics         vecs-physics (server-side simulation)
                              ↑                  ↑
        Phaser stack    vecs-phaser-server   vecs-phaser-client
                              └── vecs-phaser ───┘   (shared render components)
                              ↑                  ↑
        demo apps       apps/server          apps/client
```

- **Core** — `vecs` is the ECS everything depends on; `vecs-wire` adds binary encoding and
  `vecs-protocol` defines the replication messages on top of it.
- **Platform** — `vecs-server` (Node.js) and `vecs-client` (browser) implement the two ends of
  the protocol around a vecs world.
- **Physics** — `vecs-physics` plugs a Box2D-derived simulation into any vecs world as a module.
- **Phaser stack** — `vecs-phaser` holds the shared render components; `vecs-phaser-server` and
  `vecs-phaser-client` adapt them to the server and to a Phaser scene.
- **Demo apps** — `apps/server` and `apps/client` wire the whole stack into a running example.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```

Workspace-wide formatting uses Prettier (`npm run format` / `npm run format:check`). Both commands
exclude `.worktrees/` and `.tmp/` during traversal, so unreadable worker files cannot block checks
or releases. Run the offline regression with `node --test scripts/tests/format-worktrees.test.mjs`
as a non-root user so directory permissions are enforced. Repo
conventions for commits, formatting, testing, and documentation live in [`.agents/`](./.agents/README.md).
Performance benchmarks that run against the built packages, with instructions for profiling and
comparing two builds, live in [`bench/`](./bench/README.md).
