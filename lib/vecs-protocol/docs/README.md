# `@vworlds/vecs-protocol` documentation

Single-topic guides for `@vworlds/vecs-protocol`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs-protocol/src/` — read it in your IDE.

## Reading order

1. [Remote procedure calls](./rpc.md) — the call/answer channel, once-per-call handlers and the
   settled watermark, typed errors, reserved error and close codes, timeouts, and aborts.
2. [State diffs](./state-diffs.md) — what a diff and a baseline carry, the order a diff means
   (whole-entity removals, then snapshots, then single removals), and how a reused entity id stays
   unambiguous.

Component snapshot encoding and field ordering for networked messages live in
[`@vworlds/vecs-wire`](../../vecs-wire/README.md); this package owns the message and RPC semantics
built on top of it.

## Map

| Guide                              | Covers                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [rpc.md](./rpc.md)                 | `SessionRPC`, `RPCHandler`, `RPCError`, reserved error and close codes, `settledBelow` / `setPeerSettledBelow`, `timeoutTick`, `abortPending`. |
| [state-diffs.md](./state-diffs.md) | `StateDiff`, `ALL_COMPONENTS`, baselines, the order within a diff, resets, and the id quarantine behind them.                                  |

## See also

- [Sessions and caller context](../../vecs-server/docs/sessions.md)
- [Client world](../../vecs-client/docs/client-world.md)
- [Id pools](../../vecs/docs/components.md#id-pools)
- [vecs documentation](../../vecs/docs/README.md)
