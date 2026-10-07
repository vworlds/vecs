# Remote procedure calls

`@vworlds/vecs-protocol` carries remote procedure calls (RPCs) inside the same `Client2Server` and
`Server2Client` messages that carry state diffs. A client invokes a server handler, the server
answers, and both sides learn about failure through a typed error instead of an anonymous object.

## What you'll learn

- How `SessionRPC` keeps call/answer pairs matched.
- Why a handler runs once per call even when the caller retransmits its request, and when the
  channel lets go of a reply.
- How the two sides exchange the settled watermark that makes that possible.
- How to throw a typed `RPCError` from a server handler.
- Which error codes are reserved and what they mean, and the reserved close code that sits beside
  them.
- How timeouts and aborts reject pending calls.

## The model

An RPC is a request/reply pair over one duplex socket. There is no separate RPC channel and no
request id to allocate yourself: `SessionRPC` assigns a monotonically increasing `callId` per side
and pairs each reply with the request that produced it.

```ts
import { SessionRPC, type RPCHandler } from "@vworlds/vecs-protocol";

const client = new SessionRPC();
const server = new SessionRPC();

// A handler receives the params the caller sent and the request envelope.
const move: RPCHandler = (params, _request) => {
  return [`moved ${params[0]}`];
};
server.listen(101, move);

// Stand-in for the socket. Once per frame, each side hands the other its outgoing messages and
// its settled watermark (see below), which tells the other side what it can let go of.
setInterval(() => {
  server.setPeerSettledBelow(client.settledBelow);
  server.process(client.getOutgoing());
  client.setPeerSettledBelow(server.settledBelow);
  client.process(server.getOutgoing());
}, 33);

const answer = await client.invoke(101, ["north"]);
console.log(answer.params); // ["moved north"]
```

Handlers are registered with `listen` and invoked with `invoke`. Anything a handler returns becomes
the reply's `params`, so return the shape your caller expects to read. `invoke` resolves with the
reply message, an `RPC`.

`RPCHandler` takes an optional third type parameter for a context: `RPCHandler<TContext>` defaults
to `RPCHandler<void>`, so existing handlers keep typechecking unchanged. `SessionRPC` never supplies
a context itself — it always passes `undefined` — so a context is only meaningful when a host
library binds one. `@vworlds/vecs-server` binds
[`ServerRPCContext`](../../vecs-server/docs/sessions.md) for every session; register your handler
through `world.handleRpc` instead of `SessionRPC.listen` if you want the caller.

## Duplicates and the settled watermark

A caller keeps asking until it is answered: `getOutgoing()` returns every pending request on every
call, so a sender that ships each batch repeats a request with every frame until its reply arrives.
`ClientWorld` sends a frame about every 33 ms, and a datagram transport can also deliver an old
frame late. The same request therefore reaches `process` again and again, sometimes twice in one
batch, while a slow handler may still be running for the first copy.

`SessionRPC` runs a handler **once per call**. `process` handles each request by the first rule
that applies:

| The request…                        | What happens                                                       |
| ----------------------------------- | ------------------------------------------------------------------ |
| is below the peer's watermark       | Ignored: a stale copy of a call the caller already settled.        |
| has a cached reply                  | The cached reply is queued again, and the handler does not re-run. |
| has a handler that is still running | Ignored: the reply goes out once, when the handler settles.        |
| is new                              | The handler runs.                                                  |

A reply stays cached until the caller says it no longer needs it, not for a set time. That is what
the **watermark** is for. `settledBelow` is the lowest call id a channel still waits on, or the id
its next call will get when it waits on none, so every call below it has settled: answered,
rejected, timed out or aborted. Send it to the peer with every frame, and have the peer pass it to
`setPeerSettledBelow`:

- `setPeerSettledBelow` only moves forward, because frames can arrive out of order: a value at or
  below the current one returns at once.
- When the watermark rises, the channel deletes the cached and still unsent replies below it.
- From then on a request below it is ignored, and a handler that was still running for such a call
  has its reply discarded when it settles.

`ClientWorld` and `ServerWorld` do this on every frame. Each frame carries the sender's
`settledBelow` in its `rpcSettledBelow` field (`Client2Server` and `Server2Client`, defined in
`lib/vecs-protocol/src/messages.ts`), and the receiver passes it to `setPeerSettledBelow` before it
handles the frame's RPCs. The field is encoded as tag `5` followed by a `u32`, and only when it is
above `0`, so a frame from a peer that never made a call, or whose first call has not settled, is
byte-identical to one from before the field existed. Only the client issues calls today, so
`ServerWorld` always sends `0` and omits the field, but it still sets it on every frame to keep the
protocol symmetric.

A decoder that predates the field rejects the tag, and a client sends it once its first call has
settled, so deploy servers before clients. A new server reads frames from old and new clients alike,
but an older server cannot read a new client's frame. One that predates the
[guard for undecodable frames](../../vecs-server/docs/sessions.md#frames-that-cannot-be-decoded)
throws out of its receive handler ([#211](https://github.com/vworlds/vecs/issues/211)); one that has
it closes that client's session with `CLOSE_PROTOCOL_ERROR_CODE` instead.

A bare `SessionRPC` has to pass the watermark across itself, as the example above does. Without it
the channel that answered keeps every reply it cached, because `timeoutTick` does not age them.

One call that stays pending holds the watermark back, and the replies to later calls stay cached
until it settles. `ClientWorld` never times a call out, so a call the server never answers keeps the
replies to that client's later calls cached until the connection ends. On a channel you drive
yourself, call `timeoutTick` so a call that is never answered times out and settles.

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

| Code | Constant                     | Meaning                                                                                                            |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-1` | `RPC_TIMEOUT_CODE`           | The call outlived its ttl and no answer arrived in time.                                                           |
| `-2` | `RPC_CLOSED_CODE`            | The session ended before the answer arrived, for example on dispose.                                               |
| `1`  | `RPC_UNSPECIFIED_ERROR_CODE` | A handler threw a value with no usable code, such as a plain `Error`, or the call named an rpc id with no handler. |

Codes `0`–`100` are reserved for protocol use. Choose application codes from `101` up.

The two negative codes are raised locally and never cross the wire: a handler's code travels in a
`u32` field where `0` means success. Only codes in `[1, 4294967295]` are transmitted as thrown — `0`
would make the caller's `invoke` _resolve_ as a success, a negative would wrap to a large positive,
and anything above that range would overflow. Every other code, including non-integers, is sent as
`RPC_UNSPECIFIED_ERROR_CODE` (`1`), so the call still fails even when the handler chose a code the
wire cannot carry.

### Close codes

When a session is closed on purpose, the close notice on its graceful-close frame carries a `code`
and a `reason` — the arguments of `closeSession(connection, reason, code)` on the server. A close
code is not an RPC error code, and the two are numbered separately: the same range, `0`–`100`, is
reserved for the protocol, and applications choose their own codes above it. The protocol defines
one close code:

| Code | Constant                    | Meaning                                                                                                      |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `1`  | `CLOSE_PROTOCOL_ERROR_CODE` | The connection was closed because a frame could not be decoded, usually from incompatible protocol versions. |

That `1` is not `RPC_UNSPECIFIED_ERROR_CODE`: it travels in the close notice, never in an RPC reply.
Its reason always starts with `protocol error:`. The server closes only the offending session with
it ([Frames that cannot be decoded](../../vecs-server/docs/sessions.md#frames-that-cannot-be-decoded)),
and a client reports it on its own `disconnect` event when it cannot decode or accept what the
server sent
([Frames the client cannot decode](../../vecs-client/docs/client-world.md#frames-the-client-cannot-decode)).
`@vworlds/vecs-client` and `@vworlds/vecs-server` re-export the constant next to `RPC_CLOSED_CODE`.

## Timeouts and aborts

`invoke` accepts a `ttl` in milliseconds. `SessionRPC` never advances time on its own, so something
has to tick it. `ClientWorld` does not run `timeoutTick`, so a client call has no timeout: it
settles with its reply, or rejects with `RPC_CLOSED_CODE` when the connection is lost or the world
is disposed. A bare `SessionRPC` needs its own timer.

```ts
const pending = client.invoke(101, [], 5_000);
// once per frame, with the milliseconds elapsed since the previous tick
client.timeoutTick(16);
```

`timeoutTick` ages and rejects pending calls only. It does not expire cached replies: those wait for
the peer's watermark, as described above. A call that times out counts as settled, so `settledBelow`
moves past it.

`abortPending` rejects every in-flight call, drops queued outgoing messages, and forgets the peer:
its watermark goes back to `0`, the cached replies and the record of running handlers are cleared,
and a handler that was running when you called it has its reply discarded when it settles. Use it
when the session is going away, so no caller is left hanging on a promise that can never settle:

```ts
client.abortPending(new RPCError(RPC_CLOSED_CODE, "client left the page"));
```

Call it only when the peer is gone. `ClientWorld` calls it on disconnect and on dispose, and
`ServerWorld` calls it when a session ends. `ClientWorld` reuses its channel for the next
connection, and the next server numbers its calls from `0` again, so the channel must not judge
them by the old server's watermark or answer one with the old server's reply. The channel's own
call ids are not reset, so `settledBelow` keeps moving forward.

`abortPending` is one-shot per pending call — the next `timeoutTick` will not re-reject them.

## Reference

| Symbol                         | Description                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `new SessionRPC(defaultTtl?)`  | Create a session-local RPC channel. `defaultTtl` is the ttl of a call that names none, `5000` ms unless you pass otherwise.  |
| `listen(rpcId, handler)`       | Register the handler for one rpc id. A later registration replaces the earlier one.                                          |
| `invoke(rpcId, params?, ttl?)` | Send a request and resolve with its reply. Rejects on timeout or handler error.                                              |
| `process(incoming)`            | Dispatch inbound messages: replies settle calls, and each request runs its handler at most once.                             |
| `setPeerSettledBelow(value)`   | Record the peer's `settledBelow`. Monotonic; drops cached and unsent replies below it and ignores requests below it.         |
| `settledBelow`                 | This channel's watermark: every call below it has settled. Pass it to the peer's `setPeerSettledBelow` with every frame.     |
| `timeoutTick(elapsed)`         | Age pending calls by `elapsed` ms, rejecting the ones that run out. Does not expire cached replies.                          |
| `getOutgoing()`                | Return every pending request and the owed responses, emptying the response outbox. Pending requests come back on every call. |
| `abortPending(reason)`         | Reject every pending call with `reason`, clear the queue, and forget the peer: watermark, cached replies, running handlers.  |
| `pendingTotal`                 | Calls awaiting a response plus responses queued for the peer.                                                                |

Per-symbol detail — including the wire shape of `RPC`, `Server2Client`, and `Client2Server` — lives
in the JSDoc on `lib/vecs-protocol/src/rpc.ts` and `lib/vecs-protocol/src/messages.ts`.

## See also

- [Sessions and caller context](../../vecs-server/docs/sessions.md) — how the server binds a context
  and closes sessions.
- [Client world](../../vecs-client/docs/client-world.md) — `invoke`/`listen` on `ClientWorld` and
  disposal.
