# Sessions and caller context

`ServerWorld` owns one session per connected client. A session is a `NetworkClient` entity plus the
socket and replication state that belong to it, and every RPC the client sends is answered with that
session's own caller attached.

## What you'll learn

- What a session is and which entity represents it.
- How `handleRpc` gives every handler a `ServerRPCContext` without per-connection registration.
- How to close one session, how the close lingers until the client received the replies it is owed,
  and how to close all of them at shutdown.
- How `NetworkClient.closeReason` records why the server hung up.
- How cleanup runs exactly once, whether the server, the peer, or the application ends the session.

## The session

On a new socket the server creates an entity, attaches `Networked` and a `NetworkClient` component
whose `id` is the connection id, and registers that entity as the session's caller. `NetworkClient`
is the public surface: query it, set components on it, and use its `closeReason` to log why a
connection ended.

```ts
import { NetworkClient, ServerWorld } from "@vworlds/vecs-server";

const world = new ServerWorld({ name: "arena", networkComponents: [Position] });

world
  .system("Presence")
  .with(Networked, NetworkClient)
  .phase(PRE_STORE)
  .enter([NetworkClient], (entity, [client]) => {
    console.log(`${client.id} joined`);
  })
  .exit([NetworkClient], (_entity, [client]) => {
    console.log(`${client.id} left: ${client.closeReason ?? "unknown"}`);
  });
```

`enter`/`exit` on `NetworkClient` is the lifecycle hook you want. You do not need session internals,
and you should not reach for them.

## Caller context

`handleRpc` registers one handler for every connection. The handler's third argument is a
`ServerRPCContext`:

```ts
import type { ServerRPCContext } from "@vworlds/vecs-server";

world.handleRpc(101, (params, _request, ctx: ServerRPCContext) => {
  ctx.caller.set(SessionStats, { calls: 1 });
  return [ctx.connectionId, ctx.world.name];
});
```

| Field          | Type          | Use                                                                            |
| -------------- | ------------- | ------------------------------------------------------------------------------ |
| `world`        | `ServerWorld` | The world that owns the session — not necessarily the one you called from.     |
| `caller`       | `Entity`      | The session's `NetworkClient` entity. Attribute work and set components on it. |
| `connectionId` | `string`      | The same value as `NetworkClient.id`.                                          |

`ServerWorld` binds the context by wrapping your handler once per session, so a single shared
handler sees the right caller for every connection, including concurrent ones and connections that
arrive on later ticks. Registering a handler after clients have already connected applies to them
too.

Throw an [`RPCError`](../vecs-protocol/docs/rpc.md) to reject a call with a code the client can
branch on:

```ts
import { RPCError } from "@vworlds/vecs-protocol";

world.handleRpc(102, (_params, _request, ctx) => {
  if (!isRateLimited(ctx.connectionId)) {
    throw new RPCError(4001, "slow down");
  }
  return ["ok"];
});
```

When one `VecsListener` serves several worlds, each world binds its own context. A call handled by
`arena` carries `arena`'s world and caller, never another world's.

## Closing sessions

`closeSession` ends one connection by id or by entity. It returns `true` when a live session was
scheduled to close and `false` when the connection was already gone or belongs to another world, so
shutdown loops can call it unconditionally.

```ts
// newest authenticated connection wins
for (const previous of sessions.forPlayer(playerId)) {
  world.closeSession(previous.connectionId, `superseded by ${ctx.connectionId}`);
}
```

Pass a `reason` to record why the server hung up. It lands on `NetworkClient.closeReason` before the
entity is destroyed, so the exit system above can log it.

The reason and an optional numeric `code` also travel to the client on the close frame, so its
`disconnect` event can tell a deliberate close from a lost connection:

```ts
world.closeSession(previous.connectionId, `superseded by ${ctx.connectionId}`, SUPERSEDED);
```

Codes `0`–`100` are reserved for the protocol, as for typed RPC errors; pick your own above that
range (for example `WRONG_WORLD = 4001`, `INVALID_CREDENTIALS = 4002`, `SUPERSEDED = 4003`). A
close that carries a reason or a code always sends a close frame — see below — and the client
receives both fields on `ClientWorld`'s `disconnect` event (see
[Disconnection and disposal](../../vecs-client/docs/client-world.md#disconnection-and-disposal)).
A `closeSession(id)` with neither sends no notice, and the client sees an ordinary disconnect.

### The close is graceful

A close often has to explain itself: the common case is an `auth` handler that rejects the call with
an `RPCError` _and_ closes the connection, because the client needs the code to tell a wrong world
from a bad credential. So `closeSession` does not hang up in the middle of the handler.

It marks the session **closing**, which stops it immediately from accepting further input or
replicating any further state, and leaves the RPC replies it still owes queued in the outbox. A
session with nothing owed and no reason or code closes on the next `send()` without emitting a
frame at all. Otherwise `send()` writes those replies and the close notice on a numbered frame — an
empty diff from your last acknowledged frame — and then **lingers** before tearing the transport down:

- the client's next ack of that frame is its delivery receipt, and ends the linger immediately;
- until the ack arrives, the frame is retransmitted on every `send()`, so a datagram the unreliable
  channel lost gets another chance;
- the linger is bounded by the world's `closeLingerMs` option (250 ms by default), so a client that
  never acks cannot hold its session open.

Why the linger exists: closing the socket in the same turn as the flush would discard the queued or
in-flight datagram — the transport is an unordered channel with a limited retransmit budget — and
the client would never see the typed error. The reply is not "best effort" anymore; it is flushed,
retransmitted until acknowledged, and only then is the transport closed.

```ts
world.handleRpc(101, (params, _request, ctx) => {
  const [resumeToken] = params as [string];
  if (!sessions.authenticate(ctx.connectionId, resumeToken)) {
    world.closeSession(ctx.caller, "unauthenticated");
    throw new RPCError(4001, "unknown resume token");
  }
  return ["ok"];
});
```

The client's `invoke` then rejects with code `4001` _before_ it observes the disconnect. To close
without a pending reply — a shutdown, or a superseded connection — the same call does the job one
tick later.

Disconnects that nobody needs to explain are still immediate: the peer going away, the application
destroying the `NetworkClient` entity, and `disconnectGraceMs` expiry all tear down on the spot,
since there is no client left to answer. So does a failed send (below), including a failed flush
during the linger: the lingering session's next tick does not reach the socket again.

### Failed sends

The server never lets a failed `socket.send` escape. Every frame goes through one guarded helper
(`ServerWorld._sendFrame` in `lib/vecs-server/src/server_world.ts`): the per-tick frame, the RPC
reply flush and the flush `closeSession` owes. If `send` throws synchronously, or returns a promise
that rejects (for example `CONNECTION_CLOSED` when the client left mid-frame), the server treats it
as that session's transport `disconnect`: the same teardown runs, exactly once however many sends
fail, and the session gets no further frames. Other sessions keep receiving frames and the world
keeps ticking, and no unhandled rejection reaches the process. A `send` that returns nothing is
supported as before.

A rejection arrives on a later turn than the send, so a frame already sent in the same synchronous
turn is not recalled; the session is torn down as soon as the rejection is observed.

## Shutting down

`world.shutdown(options?)` closes every connection and stops the world's networking. It refuses
new connections, closes each session with `closeSession` (reason `"server shutting down"` unless
`options.reason` is set), then drives `send()` itself every few milliseconds until every session
has been acked or has lingered out. Unlike `closeSession`, it does not wait for your tick loop.
Sessions still present after `timeoutMs` (default `closeLingerMs + 1000`) are destroyed without
further delivery. Last, it awaits the optional `close()` of each attached socket listener.

```ts
await world.shutdown({ timeoutMs: 2000 });
```

`VecsListener.close(options?)` does the same for every registered world. Both return a promise,
and both are idempotent: later calls return the same promise and ignore their options. The dgram
`SocketListener` mounts routes on your HTTP app and has no `close()`, so stopping the HTTP server
remains yours; after shutdown, new sockets handed to the world are closed on arrival.

## Cleanup runs once

Session teardown is driven by component removal, so it runs exactly once no matter what ends the
session:

| What happened                                | Result                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closeSession(id, reason, code)`             | Session marked closing. The next `send()` destroys it at once when nothing is owed and there is no reason or code; otherwise it flushes the owed replies on a numbered frame and lingers until the client acks that frame or `closeLingerMs` elapses, then tears down: `NetworkClient` entity destroyed, session removed, socket closed. |
| The application destroys the `NetworkClient` | Immediate teardown, so app-driven disconnects close the socket too.                                                                                                                                                                                                                                                                      |
| The peer disconnects                         | Same teardown, driven from the socket's `disconnect` event — including a disconnect that arrives while the close lingers.                                                                                                                                                                                                                |
| No traffic for `disconnectGraceMs`           | Same teardown, with reason `disconnect grace period elapsed`.                                                                                                                                                                                                                                                                            |
| A frame arrives after teardown               | Dropped. The socket has no way to unsubscribe, so a finished session ignores late frames.                                                                                                                                                                                                                                                |
| A frame arrives while closing                | Only the ack is honored (it ends the linger); input and new calls are dropped.                                                                                                                                                                                                                                                           |

Because cleanup hangs off entity removal, it is observable with the normal ECS tools: destroy the
`NetworkClient` entity yourself when you want a disconnect, and react to removal with `exit`
systems.

## Reference

| Member                                           | Description                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.handleRpc(rpcId, handler)`                | Register a handler for every session, now and later.                                                                                               |
| `world.closeSession(connection, reason?, code?)` | Gracefully close one session by connection id or `NetworkClient` entity, telling the client the reason and code. Returns whether it was scheduled. |
| `world.shutdown(options?)`                       | Gracefully close every session, flush until gone or `timeoutMs`, close listeners. Idempotent.                                                      |
| `world.send()`                                   | Advance one replication frame; called by `progress()`.                                                                                             |
| `ServerRPCContext`                               | `{ world, caller, connectionId }` passed as a handler's third argument.                                                                            |
| `NetworkClient.id`                               | The connection id.                                                                                                                                 |
| `NetworkClient.closeReason`                      | Why the server closed the session, or `undefined`.                                                                                                 |
| `closeLingerMs` (`ServerWorldOptions`)           | Bound on how long a closing session waits for the ack of its reply flush before the transport closes.                                              |

Per-symbol detail lives in the JSDoc on `lib/vecs-server/src/server_world.ts` and
`lib/vecs-server/src/networked.ts`.

## See also

- [Remote procedure calls](../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Client world](../vecs-client/docs/client-world.md) — the browser side, including disposal.
