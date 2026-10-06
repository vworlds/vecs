# `@vworlds/vecs-protocol` documentation

Single-topic guides for `@vworlds/vecs-protocol`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs-protocol/src/` — read it in your IDE.

## Reading order

1. [Remote procedure calls](./rpc.md) — the call/answer channel, typed errors, reserved error and
   close codes, timeouts, and aborts.

Component snapshot encoding and field ordering for networked messages live in
[`@vworlds/vecs-wire`](../../vecs-wire/README.md); this package owns the message and RPC semantics
built on top of it.

## Map

| Guide              | Covers                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| [rpc.md](./rpc.md) | `SessionRPC`, `RPCHandler`, `RPCError`, reserved codes, `timeoutTick`, `abortPending`. |

## See also

- [Sessions and caller context](../../vecs-server/docs/sessions.md)
- [Client world](../../vecs-client/docs/client-world.md)
- [vecs documentation](../../vecs/docs/README.md)
