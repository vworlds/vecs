# `@vworlds/vecs-server` documentation

Single-topic guides for `@vworlds/vecs-server`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs-server/src/` — read it in your IDE.

## Reading order

1. [Sessions and caller context](./sessions.md) — sessions as `NetworkClient` entities, per-call
   `ServerRPCContext`, the history window and baselines (`historyFrames`), the optimistic base
   (`redundancyFrames`), the idle-session keepalive (`keepAliveFrames`), `closeSession` and its reply-flush linger, close reasons, and exactly-once
   teardown.
2. [Measuring replication](./replication-timing.md) — opt-in per-frame preparation/encoding and
   synchronous socket-send breakdowns.

## Map

| Guide                                            | Covers                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [sessions.md](./sessions.md)                     | `NetworkClient`, `ServerRPCContext`, `world.handleRpc`, `historyFrames` and baselines, `redundancyFrames`, `keepAliveFrames`, `world.closeSession`, the close linger, `world.shutdown` / `VecsListener.close`, `NetworkClient.closeReason`. |
| [replication-timing.md](./replication-timing.md) | Opt-in per-frame replication preparation/encoding and synchronous socket-send breakdowns.                                                                                                                                                   |

## See also

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Client world](../../vecs-client/docs/client-world.md) — the browser side, including disposal.
- [Replication](../../../architecture/REPLICATION.md) — the invariant, the optimistic base and its fallbacks.
- [vecs documentation](../../vecs/docs/README.md) — worlds, systems, queries, and phases.
