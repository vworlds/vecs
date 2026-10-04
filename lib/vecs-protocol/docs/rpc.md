# Remote procedure calls

`@vworlds/vecs-protocol` carries remote procedure calls (RPCs) inside the same `Client2Server` and
`Server2Client` messages that carry state diffs. A client invokes a server handler, the server
answers, and both sides learn about failure through a typed error instead of an anonymous object.

## What you'll learn

- How `SessionRPC` keeps call/answer pairs matched.
- How to throw a typed `RPCError` from a server handler.
- Which error codes are reserved and what they mean.
- How timeouts and aborts reject pending calls.

## The model

An RPC is a request/reply pair over one duplex socket. There is no separate RPC channel and no
request id to allocate yourself: `SessionRPC` assigns a monotonically increasing `callId` per side
and pairs each reply with the request that produced it.

```ts
import { SessionRPC, type RPCHandler } from "@vworlds/vecs-protocol";

const server = new SessionRPC();

// A handler receives the params the client sent and the request envelope.
const move: RPCHandler = (params, _request) => {
  return [`moved ${params[0]}`];
};
server.listen(101, move);

const answer = await server.invoke(101, ["north"]);
// -> { callId, params: ["moved north"], error: undefined }
```

Handlers are registered with `listen` and invoked with `invoke`. Anything a handler returns becomes
the reply's `params`, so return the shape your client expects to read.

`RPCHandler` takes an optional third type parameter for a context: `RPCHandler<TContext>` defaults
to `RPCHandler<void>`, so existing handlers keep typechecking unchanged. `SessionRPC` never supplies
a context itself — it always passes `undefined` — so a context is only meaningful when a host
library binds one. `@vworlds/vecs-server` binds
[`ServerRPCContext`](../vecs-server/docs/sessions.md) for every session; register your handler
through `world.handleRpc` instead of `SessionRPC.listen` if you want the caller.

## Errors

A handler reports failure by throwing. `RPCError` carries a `code` and a human-readable `message`
that both cross the wire:

```ts
import { RPCError } from "@vworlds/vecs-protocol";

server.listen(102, () => {
  throw new RPCError(4001, "unknown resume token");
});
```

The caller's promise rejects with a reconstructed `RPCError`, so the code survives the round trip
and you can branch on it:

```ts
try {
  await client.invoke(102);
} catch (error) {
  if (error instanceof RPCError && error.code === 4001) {
    // re-authenticate and retry
  }
}
```

Throwing anything other than an `RPCError` still rejects the call, but the code becomes
`RPC_UNSPECIFIED_ERROR_CODE` (`1`) and only the message survives. Throw an `RPCError` whenever the
caller needs to distinguish outcomes.

### Reserved codes

| Code | Constant                     | Meaning                                                              |
| ---- | ---------------------------- | -------------------------------------------------------------------- |
| `-1` | `RPC_TIMEOUT_CODE`           | The call outlived its ttl and no answer arrived in time.             |
| `-2` | `RPC_CLOSED_CODE`            | The session ended before the answer arrived, for example on dispose. |
| `1`  | `RPC_UNSPECIFIED_ERROR_CODE` | A handler threw a value that was not an `RPCError`.                  |

Codes `0`–`100` are reserved for protocol use. Choose application codes from `101` up.

The two negative codes are raised locally and never cross the wire: a handler's code travels in a
`u32` field where `0` means success. Only codes in `[1, 4294967295]` are transmitted as thrown — `0`
would make the caller's `invoke` _resolve_ as a success, a negative would wrap to a large positive,
and anything above that range would overflow. Every other code, including non-integers, is sent as
`RPC_UNSPECIFIED_ERROR_CODE` (`1`), so the call still fails even when the handler chose a code the
wire cannot carry.

## Timeouts and aborts

`invoke` accepts a `ttl` in milliseconds. `SessionRPC` never advances time on its own, so something
has to tick it. `ClientWorld` runs `timeoutTick` for you on its ack timer; a bare `SessionRPC` needs
its own timer.

```ts
const pending = server.invoke(101, [], 5_000);
// once per frame, with the milliseconds elapsed since the previous tick
server.timeoutTick(16);
```

`abortPending` rejects every in-flight call and drops queued outgoing messages. Use it when the
session is going away, so no caller is left hanging on a promise that can never settle:

```ts
server.abortPending(new RPCError(RPC_CLOSED_CODE, "client left the page"));
```

`abortPending` is one-shot per pending call — the next `timeoutTick` will not re-reject them.

## Reference

| Symbol                         | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `new SessionRPC(defaultTtl?)`  | Create a session-local RPC channel. `defaultTtl` is `5000` unless you pass otherwise.  |
| `listen(rpcId, handler)`       | Register the handler for one rpc id. A later registration replaces the earlier one.    |
| `invoke(rpcId, params?, ttl?)` | Send a request and resolve with its reply. Rejects on timeout or handler error.        |
| `process(incoming)`            | Handle inbound replies and client requests from the server side.                       |
| `timeoutTick(elapsed)`         | Age pending calls and cached replies by `elapsed` ms, rejecting the ones that run out. |
| `getOutgoing()`                | Drain queued requests and owed responses, emptying the outbox.                         |
| `abortPending(reason)`         | Reject every pending call with `reason` and clear the queue.                           |
| `pendingTotal`                 | Calls awaiting a response plus responses queued for the peer.                          |

Per-symbol detail — including the wire shape of `RPC`, `RPCResult`, `Server2Client`, and
`Client2Server` — lives in the JSDoc on `lib/vecs-protocol/src/rpc.ts` and
`lib/vecs-protocol/src/protocol.ts`.

## See also

- [Sessions and caller context](../vecs-server/docs/sessions.md) — how the server binds a context
  and closes sessions.
- [Client world](../vecs-client/docs/client-world.md) — `invoke`/`listen` on `ClientWorld` and
  disposal.
