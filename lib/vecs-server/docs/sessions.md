# Sessions and caller context

`ServerWorld` owns one session per connected client. A session is a `NetworkClient` entity plus the
socket and replication state that belong to it, and every RPC the client sends is answered with that
session's own caller attached.

## What you'll learn

- What a session is and which entity represents it.
- How `handleRpc` gives every handler a `ServerRPCContext` without per-connection registration.
- How the history window decides between a delta and a full baseline, why a baseline is sent once
  and then awaited, and how to size `historyFrames` for your tick rate and players' latency.
- How the server reuses entity ids without a client confusing two entities, and why an id waits
  more than `historyFrames` frames before it comes back.
- How to close one session, how the close lingers until the client received the replies it is owed,
  and how to close all of them at shutdown.
- How `NetworkClient.closeReason` records why the server hung up.
- What happens to a session that sends a frame the server cannot decode.
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

A handler runs once per call, even though the client re-sends its pending request with every ack
while the handler is still running; see
[Duplicates and the settled watermark](../../vecs-protocol/docs/rpc.md#duplicates-and-the-settled-watermark).

Throw an [`RPCError`](../../vecs-protocol/docs/rpc.md) to reject a call with a code the client can
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

## Deltas, baselines and the history window

Every `send()` numbers a frame, starting at 1 and counting up whether or not a session is connected.
`ServerWorld.frame` is the number the next `send()` uses, so during `progress()` it is the frame the
tick in flight reaches clients as; stamp state with it when a client must know the frame it holds
at, as a dead-reckoning baseline does.

For every session the server keeps the last `historyFrames` frames of what changed in that session's
view: 64 by default, about two seconds at 30 Hz. The client acks the newest frame it has received, and
each `send()` answers that ack with a **delta**, everything that changed after the acked frame,
merged out of the history. A delta is small, and the client applies it in place.

A delta can only start from a frame the client holds, and only while everything the client is missing
is still in the history. So the server asks one question of each session: has a frame the client has
not acked left the window while holding something, a snapshot or a removal? A frame that left the
history empty took nothing with it, so it does not count. If nothing is lost, the session gets a
delta, labelled with the frame the client really acked, however old that is. If something is lost,
or the session is new, the server sends a **baseline** instead: the whole view as of the current
frame, marked `fromFrame` 0.

While a view keeps changing, that question is the same as "is the client's newest ack no more than
`historyFrames` frames old?", and that is how to size the window. A view that stays quiet leaves
nothing behind, so a client whose ack is a minute old is still served a plain delta when something
finally changes, with no baseline and no rebuild.

A baseline is expensive for the client as well as the wire. `ClientWorld` applies it by destroying
every replicated entity and recreating it from the snapshot, which fires every `exit` and `enter`
again and rebuilds whatever client-side state hangs off them (see
[Client world](../../vecs-client/docs/client-world.md#baselines)). A client should see one when it
connects and after a real stall, not in steady play.

```ts
// A 60 Hz world with players up to 400 ms away: see "Sizing historyFrames" below.
const world = new ServerWorld({
  name: "arena",
  networkComponents: [Position],
  historyFrames: 68,
});
```

`historyFrames` must be an integer of at least 2; the constructor throws for anything else.

### A baseline is sent once, then awaited

After it sends a baseline, the server sends that session **no state at all** until the client acks
the baseline. A delta in the meantime would start from a frame the client may not hold, which the
client rejects, and another baseline would make it destroy and rebuild everything again for every
frame of round trip. While a baseline is in flight:

- RPC calls and replies still flow, in frames that carry no state.
- Every frame is still recorded, so the first delta after the ack carries everything that changed
  in the meantime.
- An ack of the baseline's frame, or of any later frame, ends the wait, and deltas resume from that
  ack. An older ack does not, such as the `0` a client sends before it has received anything.

The channel is unreliable, so a baseline can be lost, and a large one often is: it is split across
several datagrams, and losing any one of them loses the whole baseline. The server presumes one lost,
and sends it again, once it has gone unacked for **twice the session's smoothed ack round trip, and
at least 100 ms**. Until the session has a round-trip measurement there is nothing to scale by, so it
waits **one second**, the initial retransmission timeout of RFC 6298. That is a time, not a number of
frames, so it does not depend on the tick rate or the window.

The server measures the round trip per session. It notes when it sent each of the last 256 frames,
whatever the window, so a round trip longer than the window can still be measured. Every ack that
moves the session's acked frame is a sample, the time from sending that frame to receiving its ack.
Samples are smoothed as TCP does, so the estimate moves an eighth of the way to each new one. A
sample covers the whole loop, including the wait for the client's next ack tick, which is the lag
the server needs to allow for. The clock is `performance.now()`, and the bookkeeping is a few
operations per session per frame.

There is no backoff. If the acks never get through, every presumption interval, about two round
trips, sends the baseline again, and a client that does receive them rebuilds each time. That is
the right trade: when a large baseline really is lost, recovering from it soon matters more than the
rebuilds a dead ack path costs, and a backoff would delay both joining and recovery.

Whether an empty baseline is sent depends on what the client holds. A client that has never acked a
baseline holds nothing, so a session that can see nothing yet is sent no baseline, and the server
sends nothing for an empty diff: the first entity it can see goes out as its baseline, with no empty
one in front of it to wait on. A client that has acked one holds replicated entities, so when it
falls out of the window and everything it holds has since left its view, the baseline is sent
anyway, empty: rebuilding from nothing is what clears those entities.

| Situation                                               | What the client sees                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Connecting, window at least 2.5 times the ack lag       | One baseline, then deltas. A second only if the first was lost. |
| Steady play, window at least 2.5 times the ack lag      | Deltas only.                                                    |
| A view that stays unchanged, however long               | Nothing, then a plain delta from its old ack when it changes.   |
| Changes further apart than the window                   | Deltas only, as long as each is acked before it leaves.         |
| A stall longer than the window (backgrounded tab, drop) | One baseline once the server can reach it again, then deltas.   |
| A stall after which nothing is left in its view         | An empty baseline, which clears the entities it held.           |
| Frames arrive but acks are lost for a long time         | One baseline per presumption interval, until acks get through.  |
| A window shorter than twice the ack lag                 | A baseline again and again, about one per window: see below.    |

### Sizing `historyFrames`

An ack reaches the server one round trip, plus up to one client ack interval (33 ms by default),
after the frame it covers. That is the ack lag, in frames:

```text
ackLag = tickRateHz x (slowestRoundTripMs + ackIntervalMs) / 1000
```

The window must be longer than the lag at its worst, and the worst is about twice the steady lag. A
baseline holds state back for a round trip, so after one the client's ack is stuck at the baseline's
frame while the first delta travels out and its ack travels back, and the lag grows to twice its
usual size before it falls. The same happens after any stall. Add room for lost acks, which each add
another ack interval, and for reordering, and aim for two and a half times the lag:

```text
historyFrames >= 2.5 x ackLag
```

The default of 64 covers a 30 Hz world to about 800 ms round trips, and a 60 Hz world to about
390 ms.

| Tick rate | Slowest round trip | Ack lag (frames) | `historyFrames` at least | Use                 |
| --------- | ------------------ | ---------------- | ------------------------ | ------------------- |
| 30 Hz     | 100 ms             | 4                | 10                       | the default (64)    |
| 30 Hz     | 200 ms             | 7                | 18                       | the default         |
| 30 Hz     | 500 ms             | 16               | 40                       | the default         |
| 30 Hz     | 800 ms             | 25               | 63                       | the default, just   |
| 60 Hz     | 200 ms             | 14               | 35                       | the default         |
| 60 Hz     | 300 ms             | 20               | 50                       | the default         |
| 60 Hz     | 400 ms             | 26               | 65                       | `historyFrames: 68` |
| 120 Hz    | 200 ms             | 28               | 70                       | `historyFrames: 72` |

A window the lag outruns does not fail quietly. Shorter than twice the lag, the client is rebuilt
about once per window, over and over: each baseline's ack comes back after the window it was sent
for has already moved on. So err long. The cost of a long window is small: each session keeps one
record per frame, holding references to snapshots that are already encoded, and a delta merges only
the frames since the client's ack, so it scales with the lag the client really has, not with the
window.

To check a setting against real players, count `ClientWorld`'s `reset` events with `initial: false`.
Each one is a rebuild. A player who sees them in steady play has a window that is too short for their
connection.

### Reusing entity ids

The server hands the id of a destroyed entity to a later entity, and the wire carries no entity
generation, so a client can only tell the two entities apart by the order a diff means: within a
diff, the reset (the removal of a whole entity) comes before the snapshots of that id (see
[State diffs](../../vecs-protocol/docs/state-diffs.md)). A delta merges several frames, so it can
hold the removal of the old entity and the snapshots of the new one. The history keeps the order: it
pulls the newest reset of every entity reset within the span, with the frame at which it happened,
next to the snapshots and the removals of single components that follow it, and nothing the span did
to the entity before. A span that starts after the removal pulls the snapshots alone. A reset also
covers an entity that leaves a view and returns within one delta.

The reset is a safety net, and the id policy keeps it out of the way. A `ServerWorld` holds a freed
id out of circulation for more frames than a session keeps: at least `historyFrames + 1`, 65 with
the default window. By then the frame that removed the old entity has left every session's history,
so a client that has not acked the removal is sent a baseline, not a delta, and no delta holds both
entities.

`networkEntityReuseWaitFrames` asks for a longer quarantine. A value below `historyFrames + 1` is
raised to it, and a negative or fractional value throws. It configures the `entity` pool, the one
every entity of a server is allocated from.

```ts
const world = new ServerWorld({
  name: "arena",
  networkComponents: [Position],
  // An id waits 4 s at 30 Hz before another entity takes it, however short the history is.
  networkEntityReuseWaitFrames: 120,
});
```

Do not pass `localEntityIdStart` to a server: it splits the id space for a client, and the server
would still allocate from the `entity` pool above the split, which the option then does not
reach.

A delta starts at the newest frame the server has seen acked, so deltas that overlap while an ack is
in flight each repeat the reset until the ack passes the removal. The frame the reset carries is what
keeps that harmless: a client applies a reset once, and skips a repeat of one it holds already. See
[A reset applies once](../../vecs-protocol/docs/state-diffs.md#a-reset-applies-once).

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
range (for example `WRONG_WORLD = 4001`, `INVALID_CREDENTIALS = 4002`, `SUPERSEDED = 4003`). The
protocol itself uses `CLOSE_PROTOCOL_ERROR_CODE` (`1`) when a frame cannot be decoded; see
[Frames that cannot be decoded](#frames-that-cannot-be-decoded). A close that carries a reason or a
code always sends a close frame — see below — and the client receives both fields on
`ClientWorld`'s `disconnect` event (see
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

### Frames that cannot be decoded

The server decodes every inbound frame in one place (`ServerWorld._receive` in
`lib/vecs-server/src/server_world.ts`). A frame that fails to decode — truncated, random bytes, or
a field tag this build does not know, as one from a client on a newer protocol version would carry —
never throws into the transport. `@vworlds/dgram-server` re-emits each data-channel message to the
socket's `receive` listener without catching anything, so a throw there would be an uncaught
exception in the server process, caused by one datagram from one client.

The server treats such a frame as that session's protocol violation instead. It drops the frame and
closes the session through `closeSession`, with the reserved code `CLOSE_PROTOCOL_ERROR_CODE` (`1`,
exported by `@vworlds/vecs-protocol` and re-exported by `@vworlds/vecs-server`) and a reason of the
form `protocol error: <decoder message>`. That is the graceful close described above, so there is
nothing special to handle:
`NetworkClient.closeReason` carries the reason for your `exit` systems, the next `send()` delivers
the code and reason to the client on a numbered frame, and the session lingers until the client acks
it or `closeLingerMs` elapses and then tears down once. Only the offending session is affected;
other sessions keep receiving frames and the world keeps ticking.

A session that is already closing keeps the reason and code it was given, whether `closeSession`
or an earlier bad frame set them: a further undecodable frame is dropped and overwrites nothing.

## Shutting down

`world.shutdown(options?)` closes every connection and stops the world's networking. It refuses
new connections, closes each session with `closeSession` (reason `"server shutting down"` unless
`options.reason` is set; clients receive it as the close reason), then drives `send()` itself every few milliseconds until every session
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
| A frame cannot be decoded                    | The frame is dropped and that session alone closes as `closeSession(id, "protocol error: …", CLOSE_PROTOCOL_ERROR_CODE)`, with the usual flush and linger. A session already closing keeps its own reason.                                                                                                                               |

Because cleanup hangs off entity removal, it is observable with the normal ECS tools: destroy the
`NetworkClient` entity yourself when you want a disconnect, and react to removal with `exit`
systems.

## Reference

| Member                                           | Description                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.handleRpc(rpcId, handler)`                | Register a handler for every session, now and later.                                                                                                              |
| `world.closeSession(connection, reason?, code?)` | Gracefully close one session by connection id or `NetworkClient` entity, telling the client the reason and code. Returns whether it was scheduled.                |
| `world.shutdown(options?)`                       | Gracefully close every session, flush until gone or `timeoutMs`, close listeners. Idempotent.                                                                     |
| `world.send()`                                   | Advance one replication frame, sending each session a delta, a baseline, or nothing; called by `progress()`.                                                      |
| `ServerRPCContext`                               | `{ world, caller, connectionId }` passed as a handler's third argument.                                                                                           |
| `NetworkClient.id`                               | The connection id.                                                                                                                                                |
| `NetworkClient.closeReason`                      | Why the server closed the session, or `undefined`.                                                                                                                |
| `CLOSE_PROTOCOL_ERROR_CODE`                      | Reserved close code `1`: the session was closed because a frame could not be decoded. Also exported by `@vworlds/vecs-protocol`.                                  |
| `closeLingerMs` (`ServerWorldOptions`)           | Bound on how long a closing session waits for the ack of its reply flush before the transport closes.                                                             |
| `historyFrames` (`ServerWorldOptions`)           | Frames of history each session keeps: how far behind its ack can be, while its view keeps changing, and still get a delta. Integer of at least 2; default 64.     |
| `networkEntityReuseWaitFrames`                   | Frames a destroyed entity's id waits before another entity can take it; never fewer than `historyFrames + 1`. Non-negative integer; default 16, so 65 by default. |

Per-symbol detail lives in the JSDoc on `lib/vecs-server/src/server_world.ts`,
`lib/vecs-server/src/history.ts` (the window), `lib/vecs-server/src/rtt.ts` (the ack round-trip
estimate) and `lib/vecs-server/src/networked.ts`.

## See also

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Client world](../../vecs-client/docs/client-world.md) — the browser side, including disposal.
