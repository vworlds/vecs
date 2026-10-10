# `@vworlds/vecs-client` documentation

Single-topic guides for `@vworlds/vecs-client`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs-client/src/` — read it in your IDE.

## Reading order

1. [Client world](./client-world.md) — connecting, replication and baselines, optimistic frames and
   gaps, render time, calling the server, and disposal.

## Map

| Guide                                | Covers                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [client-world.md](./client-world.md) | `ClientWorld`, `connectDgram`, baselines and `reset`, optimistic frames and the gap report, `renderFrame`, `invoke`/`listen`, `close`, `dispose`. |

## See also

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Sessions and caller context](../../vecs-server/docs/sessions.md) — the server side.
- [Replication](../../../architecture/REPLICATION.md) — the invariant, the optimistic base and its fallbacks.
- [vecs documentation](../../vecs/docs/README.md) — worlds, systems, queries, and phases.
