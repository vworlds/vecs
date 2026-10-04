# Sessions and caller context

`ServerWorld` owns one session per connected client. A session is a `NetworkClient` entity plus the
socket and replication state that belong to it, and every RPC the client sends is answered with that
session's own caller attached.

## What you'll learn

- What a session is and which entity represents it.
- How `handleRpc` gives every handler a `ServerRPCContext` without per-connection registration.
- How to close one session, and how to close all of them at shutdown.
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

### The close is graceful

A close often has to explain itself: the common case is an `auth` handler that rejects the call with
an `RPCError` _and_ closes the connection, because the client needs the code to tell a wrong world
from a bad credential. So `closeSession` does not hang up in the middle of the handler.

It marks the session **closing**, which stops it immediately from accepting further input or
replicating any further state, and leaves the RPC replies it still owes queued in the outbox. The
next `send()` — the next tick — writes those replies, best effort over the unreliable datagram
channel, and then completes the teardown: the `NetworkClient` entity is destroyed and the socket is
closed. A session with nothing owed closes without emitting a frame at all.

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
since there is no client left to answer.

To close every connection at shutdown, query `NetworkClient` entities:

```ts
world
  .query("shutdown:clients")
  .with(NetworkClient)
  .track()
  .build()
  .forEach((entity) => {
    world.closeSession(entity, "server shutting down");
  });
```

Build the query before you iterate it — an untracked, unbuilt query matches nothing.

## Cleanup runs once

Session teardown is driven by component removal, so it runs exactly once no matter what ends the
session:

| What happened                                    | Result                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closeSession(id, reason)`                       | Session marked closing, then the next `send()` flushes owed replies and tears down: `NetworkClient` entity destroyed, session removed, socket closed. |
| The application destroys the `NetworkClient`     | Immediate teardown, so app-driven disconnects close the socket too.                                                                                   |
| The peer disconnects                             | Same teardown, driven from the socket's `disconnect` event.                                                                                           |
| No traffic for `disconnectGraceMs`               | Same teardown, with reason `disconnect grace period elapsed`.                                                                                         |
| A frame arrives after teardown, or while closing | Dropped. The socket has no way to unsubscribe, so a finished session ignores late frames.                                                             |

Because cleanup hangs off entity removal, it is observable with the normal ECS tools: destroy the
`NetworkClient` entity yourself when you want a disconnect, and react to removal with `exit`
systems.

## Reference

| Member                                    | Description                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `world.handleRpc(rpcId, handler)`         | Register a handler for every session, now and later.                                                       |
| `world.closeSession(connection, reason?)` | Gracefully close one session by connection id or `NetworkClient` entity. Returns whether it was scheduled. |
| `world.send()`                            | Advance one replication frame; called by `progress()`.                                                     |
| `ServerRPCContext`                        | `{ world, caller, connectionId }` passed as a handler's third argument.                                    |
| `NetworkClient.id`                        | The connection id.                                                                                         |
| `NetworkClient.closeReason`               | Why the server closed the session, or `undefined`.                                                         |

Per-symbol detail lives in the JSDoc on `lib/vecs-server/src/server_world.ts` and
`lib/vecs-server/src/networked.ts`.

## See also

- [Remote procedure calls](../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Client world](../vecs-client/docs/client-world.md) — the browser side, including disposal.
