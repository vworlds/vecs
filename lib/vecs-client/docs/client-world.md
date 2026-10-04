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

## Disposal

`close` closes the socket but leaves the world usable: a reconnect or a fresh socket still works.
`dispose` is the one-way teardown, for when a `ClientWorld` is finished for good — a hot reload, a
route change, or a game instance you are throwing away.

```ts
world.dispose();
```

In order, `dispose`:

1. rejects every pending `invoke` with an `RPCError` carrying `RPC_CLOSED_CODE`,
2. drops buffered RPC requests and frames,
3. destroys the replicated `Networked` entities, firing their exit systems,
4. resets the diff buffer so a new world starts from a clean baseline, and
5. closes the socket.

Rejecting pending calls is the load-bearing step. Nothing else ticks a disposed world, so a call
made just before teardown would otherwise wait out its full ttl — or forever — and leave the caller
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

| Member                              | Description                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `ClientWorld.connectDgram(options)` | Connect over the dgram transport and return a world with its socket attached.  |
| `world.attachSocket(socket)`        | Bind a socket and start the ack timer. Throws after disposal.                  |
| `world.setInput(input)`             | Set the input replicated on the next outgoing frame.                           |
| `world.invoke(rpcId, params?)`      | Call the server; resolves with reply params.                                   |
| `world.listen(rpcId, handler)`      | Register a handler for calls the server makes on this client.                  |
| `world.apply(now)`                  | Run queued RPC handlers, then apply buffered frames.                           |
| `world.send()`                      | Send input, outstanding replies, and the current ack frame.                    |
| `world.close()`                     | Close the socket, leaving the world reusable.                                  |
| `world.dispose()`                   | One-way teardown: reject pending calls, clear state, destroy network entities. |

Per-symbol detail lives in the JSDoc on `lib/vecs-client/src/client_world.ts` and
`lib/vecs-client/src/diff_buffer.ts`.

## See also

- [Remote procedure calls](../vecs-protocol/docs/rpc.md) — the call channel and reserved codes.
- [Sessions and caller context](../vecs-server/docs/sessions.md) — the server side of the same
  connection.
