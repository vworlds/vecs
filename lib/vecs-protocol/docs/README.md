# `@vworlds/vecs-protocol` documentation

Single-topic guides for `@vworlds/vecs-protocol`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs-protocol/src/` — read it in your IDE.

## Reading order

1. [Frames](./frames.md) — the `Server2Client` and `Client2Server` messages, their fields and tags,
   how a diff is labelled, and the optimistic marker and gap report.
2. [Remote procedure calls](./rpc.md) — the call/answer channel, once-per-call handlers and the
   settled watermark, typed errors, reserved error and close codes, timeouts, and aborts.
3. [State diffs](./state-diffs.md) — what a diff and a baseline carry, the order a diff means
   (resets, then snapshots, then single removals), why a reset carries its frame and applies once,
   and how a reused entity id stays unambiguous.

Component snapshot encoding and field ordering for networked messages live in
[`@vworlds/vecs-wire`](../../vecs-wire/README.md); this package owns the message and RPC semantics
built on top of it.

## Map

| Guide                              | Covers                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [frames.md](./frames.md)           | `Server2Client`, `Client2Server`, `StateDiff`, field tags, baselines and deltas, `optimistic`, `gap`, `CLOSE_PROTOCOL_ERROR_CODE`.             |
| [rpc.md](./rpc.md)                 | `SessionRPC`, `RPCHandler`, `RPCError`, reserved error and close codes, `settledBelow` / `setPeerSettledBelow`, `timeoutTick`, `abortPending`. |
| [state-diffs.md](./state-diffs.md) | `StateDiff`, `EntityReset`, baselines, the order within a diff, idempotent resets, the wire format, and the id quarantine behind them.         |

## See also

- [Replication](../../../architecture/REPLICATION.md) — the invariant behind the frames.
- [Sessions and caller context](../../vecs-server/docs/sessions.md)
- [Client world](../../vecs-client/docs/client-world.md)
- [Id pools](../../vecs/docs/components.md#id-pools)
- [vecs documentation](../../vecs/docs/README.md)
