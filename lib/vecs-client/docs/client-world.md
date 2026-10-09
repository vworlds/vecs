# Client world

`ClientWorld` is the browser-side mirror of a `ServerWorld`: it applies replicated component
snapshots, interpolates between server ticks, and carries the RPC channel back to the server. It
also knows when to let go of all of it.

## What you'll learn

- How to connect a client world and let replication run.
- What a baseline does to your replicated entities, and how often to expect one.
- What the client does with an optimistic frame whose base it never received, and what a gap costs.
- Which server frame the world renders, and how to put client-computed state on the same timeline.
- How to call a server RPC and answer server calls.
- How `dispose` tears a world down and why pending calls must be rejected.
- What changes after disposal.
- What the client does when it cannot decode or accept a frame, a diff or a snapshot from the
  server.

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

## Baselines

Most frames are deltas, which the client applies in place. The server sends a **baseline** instead,
the complete state of the client's view (`fromFrame` 0), in two situations: when the session starts,
which includes a reconnect, and when the client has fallen so far behind that frames it has not
acked have left the server's history window, as a backgrounded tab or a stalled connection does. A
view that is merely quiet gets none: the server sends nothing while nothing changes, and the next
change arrives as an ordinary delta.

The client applies a baseline as reset-then-rebuild. It destroys every replicated entity and then
recreates each one from the snapshot, so every `exit` and `enter` fires again, and view systems that
attach client-side state on `enter` build it again. The world emits `reset` as it does so, with
`{ initial, fromFrame, toFrame }`; `initial` is `true` for the first baseline the world applies. A
baseline for a frame the client has already passed (a duplicate, or a straggler on the unordered
channel) is ignored, and a delta for a frame it has already received is discarded, or merged into
the copy the diff buffer still holds, so a late datagram never rolls the client back.

```ts
world.events.on("reset", ({ initial }) => {
  if (!initial) {
    console.warn("the server resent the whole world after a stall");
  }
});
```

The server sends one baseline and then waits for the client to ack it before it sends more state,
sending another only if it presumes the first was lost. So a client sees a baseline when it connects
and once per real stall, not once per frame. When the server sends them, how it retries, and how to
size the window for slow players are in
[Sessions](../../vecs-server/docs/sessions.md#deltas-baselines-and-the-history-window).

## Optimistic frames and gaps

A server built with `redundancyFrames` (see
[Sessions](../../vecs-server/docs/sessions.md#redundancy-redundancyframes)) sends some deltas from a
frame later than the one the client last acked, presuming the client already holds it. It marks such
a frame optimistic. When the frames in between were lost, the diff starts past the newest frame the
client has, and the client cannot apply it yet. That is not an error, as it is for an unmarked diff,
and the client does not close.

It holds the diff instead, in a small set that keeps at most 8 and drops the oldest. As soon as the
client's frame reaches the diff's start the diff is applied, and it is dropped once a later frame has
passed its end. So a frame that was only delayed or reordered heals with no round trip, and the
server's fallback delta, which starts from the acked frame, supersedes whatever is still held. While
it holds a diff the client's ack stays at the last frame it applied, and the next `send()` also
reports the gap, once per held diff, so that the server sends deltas from the ack until the client has
caught up. A gap that closed before the ack went out is not reported.

In practice the gap shows as the replicated state standing still for about a round trip after the
last `redundancyFrames` frames the server sent were all lost; the interpolation buffer hides part of it. Nothing
changes in your code: there is no event for it, and no `reset`. An unmarked diff that starts past the
client's frame is still a protocol error, as under
[Frames the client cannot decode](#frames-the-client-cannot-decode). The mechanism is in
[Replication](../../../architecture/REPLICATION.md#when-the-presumption-is-wrong).

## Render time

The world renders slightly in the past: frames wait in the diff buffer, and the interpolators blend
between two of them. `world.renderFrame` says where on the server's timeline that is, as a fractional
server frame. While the world blends from frame N toward frame N + 1 with blend factor `alpha`, it is
`N + alpha`, the same point the interpolators sample. It is kept whether or not you register any
interpolators.

Use it for state the client computes on its own, so it shows the same moment as the replicated state.
A pose extrapolated from a baseline the server took at a known frame, for example, has to be advanced
to `renderFrame`, not to the newest frame received or to wall-clock time:

```ts
/** Seconds of server time between `frame` and the moment the world renders. */
function sinceFrame(world: ClientWorld, frame: number, stepSeconds: number): number {
  return (world.renderFrame - frame) * stepSeconds;
}
```

| When                                  | `renderFrame`                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Before the first baseline is applied  | `0`.                                                                                  |
| Each `apply()` (`progress()` runs it) | Moves forward, never back, as long as `now` never decreases.                          |
| The buffer runs dry                   | Holds at the newest frame applied. It never runs past the newest frame received.      |
| A baseline resets the world           | `0` as the replicated entities are destroyed, then the baseline's frame once applied. |
| After `dispose()`                     | `0`.                                                                                  |

Only a reset moves it back. After a reconnect the baseline's frame can even be lower than before,
because the new server's frame counter can start over. And since it never runs past the newest frame
received, anything that should keep moving while frames are late has to extrapolate past it itself.

## Calling the server

`invoke` sends a call and resolves with the reply's params. It rejects with an
[`RPCError`](../../vecs-protocol/docs/rpc.md) carrying the server's code and message.

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

A call settles as soon as its reply arrives, whether or not anything applies the world. It does not
wait for `apply()` or `progress()`, so you can await a call such as `auth` right after connecting,
before your tick loop starts. Until the reply arrives, the call's request is sent again with every
ack; once the reply is in, the request is not sent again. The reply settles the call and nothing
more: the state the server sent in the same frame is applied later, by `apply()` and possibly after
interpolation delay, so when the promise resolves the reply's side effects are not necessarily
visible in the world yet. If the reply arrives in the same frame as a full [baseline](#baselines)
(the server sends one when the session starts, which includes a reconnect, and again only when a
client falls outside its history window), the client clears its replicated entities as the frame
arrives and rebuilds them on the next `apply()`. Code that runs right after the call settles sees
none of them until then.

`listen` registers the other direction — a handler the server can call on this client. Unlike a
reply, a server request waits for `apply()`: its handler runs there, so under `progress()` it runs in
the world's `ON_LOAD` phase, in order with your other systems. Its answer goes out with the next ack:

```ts
world.listen(201, ([question]) => {
  world.invoke(202, [question]);
  return ["asked"];
});
```

The handler runs once per call, however many copies of the request the server sends; see
[Duplicates and the settled watermark](../../vecs-protocol/docs/rpc.md#duplicates-and-the-settled-watermark).

`ClientWorld` does not time calls out: its ack timer only sends frames and never runs
`SessionRPC.timeoutTick`. A call settles with its reply, or rejects with `RPC_CLOSED_CODE` when the
connection is lost or the world is disposed; one the server never answers stays pending until then.

## Disconnection and disposal

When the peer disconnects, `ClientWorld` stops its ack timer, emits `disconnect` once, and rejects
every pending `invoke` with an `RPCError` carrying `RPC_CLOSED_CODE`. A synchronous throw or rejected
promise from `VecsSocket.send` follows the same path, so a transport that misses or delays its
`disconnect` event cannot leave an ack rejection or RPC hanging.

Replies the client has already received are never lost to the disconnect, because a reply settles its
call the moment it arrives: a call whose reply has arrived has already resolved with its params, or
rejected with the server's `RPCError`, by the time a later disconnect happens, whether or not
`apply()` has run since. A server that rejects `auth` with a typed code and then closes the session
therefore delivers that code, not `RPC_CLOSED_CODE`, even when the reply and the close notice share
a frame: the client handles the reply first. Only calls whose reply has not arrived reject with
`RPC_CLOSED_CODE`. Server-to-client _requests_ still queued for `apply()` are dropped without
running: the dead connection cannot carry their replies, and they must never execute on a later
connection. Callers can rely on settlement happening before the `disconnect` event is emitted;
promise continuations still run as microtasks after the emitting code returns, so they observe the
settled call before any later macrotask.

### Why the server closed

`disconnect` carries an optional payload, `{ code?: number; reason?: string }`
(`ClientWorldDisconnectEvent`). It is present when the server closed the session on purpose with
`closeSession(connection, reason, code)` and the close frame arrived; the world acks that frame, so
the server can finish promptly, then disconnects. Owed replies in the same frame settle first, as
above. It is also present, with code `CLOSE_PROTOCOL_ERROR_CODE` (`1`), when the client closes
itself because it cannot decode or accept what the server sent; see
[Frames the client cannot decode](#frames-the-client-cannot-decode). The payload is `undefined` for
transport loss, a failed send, or a local `close()`:

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
socket (a received frame, `disconnect`, or a rejected send) are ignored instead of reaching the new
connection. A frame that straggles in on the old socket is neither applied nor acked, whether it is
a diff from the old server session, a retransmitted close notice, or garbage.

`close` follows that disconnection path and closes the socket, but leaves replicated entities and
the diff buffer intact: attach a fresh socket and its next baseline resynchronizes the world. `dispose`
is the one-way teardown, for when a `ClientWorld` is finished for good — a hot reload, a route change,
or a game instance you are throwing away.

```ts
world.dispose();
```

In order, `dispose`:

1. rejects every pending `invoke` with an `RPCError` carrying `RPC_CLOSED_CODE`,
2. drops the server-to-client requests still queued for `apply()`, without running them,
3. destroys the replicated `Networked` entities, firing their components' `remove` hooks,
4. resets the diff buffer so a new world starts from a clean baseline,
5. closes the socket, and
6. destroys every other entity through
   [`World.dispose()`](../../vecs/docs/entities.md#disposing-a-world): the client-local ones, such
   as UI, effects and `DrawBy` children, so their `remove` hooks release their resources too.

Steps 3 and 6 are what free render resources. A Phaser `GameObject` attached to an entity as a
component is destroyed by its `remove` hook, so it goes whether the entity is replicated or local,
and no module-level sweep is needed. Replicated entities go first, then the client-local ones;
within each group the order is unspecified. The client's own component, query and system entities
stay, as in any world, and so does data a module stores on a component entity with `world.set`:
release that yourself. A system's `exit` callback only queues its event, and a disposed world never
runs the system again, so do the releasing in `remove` hooks.

`dispose()` can run while the world is deferred, for example in a `disconnect` handler that
`apply()` triggers when it closes the client for a protocol error. The destruction is then queued
like any `destroy()` and completes when the running system finishes.

A call whose reply has already arrived is not rejected: it settled when the reply came in, so
disposal only rejects the calls still waiting for one.

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

The entity API is not guarded, so `entity()` and `progress()` still run on a disposed world, but it
must not be used again ([Disposing a world](../../vecs/docs/entities.md#disposing-a-world)). Build
a new `ClientWorld` to start over; the constructor has no internal state tied to the previous one.

## Frames the client cannot decode

The client decodes each incoming frame as a whole, reads the snapshots out of its diff as it buffers
it, and decodes each snapshot's payload as `apply()` applies it. When any of those fails, or the diff
buffer rejects the diff, the client does not throw into the transport or out of `apply()` and
`progress()`. The cause is a frame that is truncated or garbled, a field tag this build does not
know, a snapshot with a malformed envelope or payload, a snapshot of a wire type this world did not
register, an `Exclusive` relationship snapshot with more than one target, or a diff that starts after
the last frame the client acknowledged without the server marking it optimistic, which a server that
honors acks never sends — in practice usually a server built from a newer or otherwise incompatible
protocol version.

Instead, the client closes the connection through the path `close()` uses: it stops the ack timer,
emits `disconnect` once, rejects every pending `invoke` with `RPC_CLOSED_CODE`, and closes the
socket. Nothing is sent to the server, because the protocol has no client-to-server close notice.
The `disconnect` payload is the client's own notice: `code` is `CLOSE_PROTOCOL_ERROR_CODE` (`1`), and
`reason` is `"protocol error: "` followed by the message of the error that caused the close.

```ts
import { CLOSE_PROTOCOL_ERROR_CODE } from "@vworlds/vecs-client";

world.events.on("disconnect", (event) => {
  if (event?.code === CLOSE_PROTOCOL_ERROR_CODE) {
    // The two sides likely run different protocol versions: reconnecting with this build won't help
    showUpdateRequired(event.reason);
  }
});
```

A frame that fails to decode is dropped whole. When the diff inside a decodable frame is rejected,
the replies in that frame have already settled their calls, as always, but the diff is not applied
and the close notice in the same frame is not handled. A baseline that cannot be read is rejected
before anything is torn down, so the replicated entities stay in place and no `reset` event fires.
For a snapshot, `apply()` stops at the one that failed: snapshots before it stay applied, and no
later snapshot and no removal from that diff is applied. Replicated entities stay in place, as after
any `close()`, and a new socket's next baseline resynchronizes them.

Only reading, buffering and decoding are guarded. An exception thrown by your own code — a `reset`
handler, an `on("remove")` hook that runs when a baseline destroys the replicated entities, or an
`on("set")` hook that runs as a valid snapshot's component is attached — is an application bug: it
still propagates and does not disconnect the client. Nor are the snapshots of a component that has
an interpolator covered in full: the diff buffer decodes those earlier, while it blends frames, and
a payload that fails there still throws out of `apply()`.

## Reference

| Member                              | Description                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `ClientWorld.connectDgram(options)` | Connect over the dgram transport, then attach; returns a world with a connected socket.  |
| `world.attachSocket(socket)`        | Bind a connected socket and start the ack timer. Throws after disposal.                  |
| `world.setInput(input)`             | Set the input replicated on the next outgoing frame.                                     |
| `world.invoke(rpcId, params?)`      | Call the server; settles with the reply params as soon as the reply arrives.             |
| `world.listen(rpcId, handler)`      | Register a handler for calls the server makes on this client; it runs from `apply()`.    |
| `world.apply(now)`                  | Run the handlers of queued server requests, then apply buffered frames.                  |
| `world.renderFrame`                 | The fractional server frame the world renders; `0` before the first baseline.            |
| `world.send()`                      | Send input, outstanding replies, the current ack frame, and a gap report if one is open. |
| `world.close()`                     | Disconnect, reject pending calls, and close the socket while leaving state reusable.     |
| `world.dispose()`                   | One-way teardown: reject calls, close the socket, destroy network and local entities.    |

Per-symbol detail lives in the JSDoc on `lib/vecs-client/src/client_world.ts` and
`lib/vecs-client/src/diff_buffer.ts`.

## See also

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and reserved codes.
- [Sessions and caller context](../../vecs-server/docs/sessions.md) — the server side of the same
  connection.
