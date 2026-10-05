# Client world

`ClientWorld` is the browser-side mirror of a `ServerWorld`: it applies replicated component
snapshots, interpolates between server ticks, and carries the RPC channel back to the server. It
also knows when to let go of all of it.

## What you'll learn

- How to connect a client world and let replication run.
- How to call a server RPC and answer server calls.
- How `dispose` tears a world down and why pending calls must be rejected.
- What changes after disposal.

## Connecting

Either build the world with a socket or let `connectDgram` do both. The world installs its own
`Apply` system in the `ON_LOAD` phase, so a normal `progress()` loop applies everything that has
arrived.

```ts
import { ClientWorld, interpolatePosition } from "@vworlds/vecs-client";

const world = await ClientWorld.connectDgram({
  host: "localhost",
  port: 8080,
  worldName: "arena",
  networkComponents: [Position],
  interpolators: [[Position, interpolatePosition]],
});

// per frame, from your render loop
world.progress(performance.now(), 16);
```

To drive a world yourself instead — in a test, or behind your own loop — hand it a `VecsSocket`
directly with `attachSocket` and call `apply(now)` when you want buffered frames applied.

Only attach a socket that is already **connected**. `attachSocket` (and the `socket` option) starts
the ack timer, and an ack the transport rejects because it is not ready, such as dgram's
`DATA_CHANNEL_NOT_CREATED` before the data channel opens, counts as a failed send and tears the
world down as a disconnect. `connectDgram` therefore builds the world without a socket, awaits
`connect()`, and only then attaches; if `connect()` rejects, it disposes the world, closes the
socket, and rethrows. The client cannot instead wait for the first server frame before acking: the
server sends nothing while a session has an empty diff and no RPC replies, and it closes sessions
that stay silent past `disconnectGraceMs`, so a client that withheld its first ack could be
dropped, or could never deliver an early `invoke`.

## Calling the server

`invoke` sends a call and resolves with the reply's params. It rejects with an
[`RPCError`](../vecs-protocol/docs/rpc.md) carrying the server's code and message.

```ts
import { RPCError } from "@vworlds/vecs-protocol";

try {
  const [message] = await world.invoke(101, ["north"]);
  console.log(message);
} catch (error) {
  if (error instanceof RPCError && error.code === 4001) {
    // the server rejected this call and said why
  }
}
```

`listen` registers the other direction — a handler the server can call on this client:

```ts
world.listen(201, ([question]) => {
  world.invoke(202, [question]);
  return ["asked"];
});
```

The ack timer that ships frames to the server also ages pending calls, so a call that is never
answered times out on its own.

## Disconnection and disposal

When the peer disconnects, `ClientWorld` stops its ack timer, emits `disconnect` once, and rejects
every pending `invoke` with an `RPCError` carrying `RPC_CLOSED_CODE`. A synchronous throw or rejected
promise from `VecsSocket.send` follows the same path, so a transport that misses or delays its
`disconnect` event cannot leave an ack rejection or RPC hanging.

Replies the client has already received are never lost to the disconnect. `ClientWorld` applies
incoming RPCs from `apply()`, so a reply and a disconnect can both arrive between two `apply()` calls.
On disconnect, before rejecting anything, the world settles every queued _response_: a pending call
whose reply is queued resolves with its params or rejects with the server's `RPCError`, exactly as
if `apply()` had run first. A server that rejects `auth` with a typed code and then closes the
session therefore delivers that code, not `RPC_CLOSED_CODE`. Only calls with no queued reply reject
with `RPC_CLOSED_CODE`. Server-to-client _requests_ still queued are dropped without running: the dead
connection cannot carry their replies, and they must never execute on a later connection. Callers can
rely on settlement happening before the `disconnect` event is emitted; promise continuations still run
as microtasks after the emitting code returns, so they observe the settled call before any later
macrotask.

### Why the server closed

`disconnect` carries an optional payload, `{ code?: number; reason?: string }`
(`ClientWorldDisconnectEvent`). It is present when the server closed the session on purpose with
`closeSession(connection, reason, code)` and the close frame arrived; the world acks that frame, so
the server can finish promptly, then disconnects. Owed replies in the same frame settle first, as
above. The payload is `undefined` for transport loss, a failed send, or a local `close()`:

```ts
const SUPERSEDED = 4003; // application code; 0–100 is reserved for the protocol

world.events.on("disconnect", (event) => {
  if (event?.code === SUPERSEDED) {
    showResumeHere(event.reason); // another tab took the session: do not auto-reconnect
  } else {
    reconnect();
  }
});
```

`dispose()` does not emit `disconnect`, so it never carries a payload either.

The same rejection applies to calls made _after_ the disconnect: until you attach a replacement
socket, `invoke` returns a promise rejected with `RPC_CLOSED_CODE` and queues nothing. A queued call
would either hang forever or be sent on the next connection, which may be a different server world
(a sector switch), so a stale action could run in the wrong place. Calls made before the first
`attachSocket` are different — nothing has been lost yet — so they stay queued and are sent on
connect. After `attachSocket(newSocket)`, `invoke` works normally, and late events from the old
socket (`disconnect` or a rejected send) are ignored instead of tearing down the new connection.

`close` follows that disconnection path and closes the socket, but leaves replicated entities and
the diff buffer intact: attach a fresh socket and its next baseline resynchronizes the world. `dispose`
is the one-way teardown, for when a `ClientWorld` is finished for good — a hot reload, a route change,
or a game instance you are throwing away.

```ts
world.dispose();
```

In order, `dispose`:

1. rejects every pending `invoke` with an `RPCError` carrying `RPC_CLOSED_CODE`,
2. drops buffered RPCs (replies included, since a disposed world abandons everything) and frames,
3. destroys the replicated `Networked` entities, firing their exit systems,
4. resets the diff buffer so a new world starts from a clean baseline, and
5. closes the socket.

Rejecting pending calls is the load-bearing step. Nothing else can obtain a reply after a disconnect
or disposal, so a call made just before either event would otherwise wait forever and leave the caller
hanging.

After disposal the world is inert, and stays that way:

| Call                           | Result                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `dispose()`                    | No-op. Safe to call from a teardown path that may run twice. |
| `invoke(...)`                  | Returns a rejected promise with code `RPC_CLOSED_CODE`.      |
| `attachSocket(socket)`         | Throws `ClientWorld is disposed`.                            |
| `send()`                       | No-op.                                                       |
| Incoming frames or disconnects | Ignored.                                                     |

Frames that arrive after disposal are dropped rather than applied, so a socket that outlives its
world cannot resurrect entities. `VecsSocket` has no `off`, which is why disposal guards the
handlers instead of removing them — the alternative would let a stale socket mutate a live world.

Build a new `ClientWorld` to start over; the constructor has no internal state tied to the previous
one.

## Reference

| Member                              | Description                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `ClientWorld.connectDgram(options)` | Connect over the dgram transport, then attach; returns a world with a connected socket. |
| `world.attachSocket(socket)`        | Bind a connected socket and start the ack timer. Throws after disposal.                 |
| `world.setInput(input)`             | Set the input replicated on the next outgoing frame.                                    |
| `world.invoke(rpcId, params?)`      | Call the server; resolves with reply params.                                            |
| `world.listen(rpcId, handler)`      | Register a handler for calls the server makes on this client.                           |
| `world.apply(now)`                  | Run queued RPC handlers, then apply buffered frames.                                    |
| `world.send()`                      | Send input, outstanding replies, and the current ack frame.                             |
| `world.close()`                     | Disconnect, reject pending calls, and close the socket while leaving state reusable.    |
| `world.dispose()`                   | One-way teardown: reject pending calls, clear state, destroy network entities.          |

Per-symbol detail lives in the JSDoc on `lib/vecs-client/src/client_world.ts` and
`lib/vecs-client/src/diff_buffer.ts`.

## See also

- [Remote procedure calls](../vecs-protocol/docs/rpc.md) — the call channel and reserved codes.
- [Sessions and caller context](../vecs-server/docs/sessions.md) — the server side of the same
  connection.
