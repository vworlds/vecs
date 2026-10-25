# Sessions and caller context

`ServerWorld` owns one session per connected client. A session is a `NetworkClient` entity plus the
socket and replication state that belong to it, and every RPC the client sends is answered with that
session's own caller attached.

## What you'll learn

- What a session is and which entity represents it.
- How `handleRpc` gives every handler a `ServerRPCContext` without per-connection registration.
- How the history window decides between a delta and a full baseline, why a baseline is sent once
  and then awaited, and how to size `historyFrames` for your tick rate and players' latency.
- How `redundancyFrames` stops a change being resent in every frame until it is acked, and what it
  costs when frames are lost.
- Why a session whose view is quiet is sent nothing, and how `keepAliveFrames` keeps the client's
  `renderFrame` moving anyway, which dead reckoning needs.
- How the server reuses entity ids without a client confusing two entities, and why an id waits
  more than `historyFrames` frames before it comes back.
- How to close one session, how the close lingers until the client received the replies it is owed,
  and how to close all of them at shutdown.
- How `NetworkClient.closeReason` records why the server hung up.
- What happens to a session that sends a frame the server cannot decode.
- How cleanup runs exactly once, whether the server, the peer, or the application ends the session.

## The session

For diagnostics, `ServerWorld.toJSON()` adds the configured server `name` to the base
`{ world: constructor.name, entities: liveEntityCount }` summary. It does not traverse sessions
or component data. See [testing and diagnostic summaries](../../vecs/docs/testing.md).

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

`handleRpc(rpcId, handler): void` registers one handler for every connection.
Use names such as `handleRpc("auth", handler)`; numeric application ids in
101–2147483647 remain supported. See [names and numeric request ids](../../vecs-protocol/docs/rpc.md#names-and-numeric-request-ids)
for hashing, collision detection and reserved ranges.
Keep the handler reference and pass it to `unhandleRpc(rpcId, handler): boolean`
to remove that registration from existing and future connections. Removal returns
`true` only when that exact handler is currently registered; otherwise it returns
`false` and leaves a newer replacement untouched. Calls already in flight still settle.
The handler's third argument is a
`ServerRPCContext`:

```ts
import type { ServerRPCContext } from "@vworlds/vecs-server";

world.handleRpc("auth", (params, _request, ctx: ServerRPCContext) => {
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

world.handleRpc("spend", (_params, _request, ctx) => {
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
| A view that stays unchanged, however long               | Keepalives if enabled; otherwise no state until it changes.     |
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

`localEntityIdStart` splits the id space for a `ClientWorld` only. `ServerWorld` rejects it at
construction because the server allocates every id from its `entity` pool.

Deltas whose spans include a reset repeat it until their base passes the removal, whether the
base is the ack or an optimistic state frame. A client applies a reset once, and skips a repeat
of one it holds already. See
[A reset applies once](../../vecs-protocol/docs/state-diffs.md#a-reset-applies-once).

### Redundancy: `redundancyFrames`

A delta starts at the client's ack, which trails the frame being sent by the ack lag. A change that
happens once and then sits still, such as the baseline of a dead-reckoned body, is therefore in every
frame's delta until its ack arrives: `ackLag + 1` copies, 7 at 30 Hz and a 200 ms round trip. Changes
that are superseded by a later one cost nothing extra, because the merge keeps one value per component.

`redundancyFrames` trades that for a fixed redundancy. Set it to `R` and every healthy session's
delta starts at the state frame of the send `R` sends ago, instead of at its ack. A send is a
baseline, a delta with content or a [keepalive](#keepalive-keepaliveframes), and its state frame is
the newest frame at which the session's replicated state had changed as of that send: its own frame
when it carries a new change, and the earlier frame of the change when it only repeats it or carries
nothing. Content includes resets, even without snapshots or per-component removals.
In a view that changes on every frame that is `R` frames before the frame being sent. A
change is sent in `R` consecutive sends and no more, whatever the lag and however sparse the traffic:

```ts
const world = new ServerWorld({
  name: "arena",
  networkComponents: [Position],
  historyFrames: 64,
  redundancyFrames: 2,
});
```

It is off by default, so no optimistic marker is sent. `R` must be an integer of at least 1 and less
than `historyFrames`; the constructor throws for anything else. The client must understand the
optimistic marker: a client built before it closes the connection on the unknown field. The
entity-reset wire layout is also incompatible with 1.0.50, so upgrade server and client together.

The price is paid when the redundancy runs out. A delta that starts past the ack presumes the client
received the frame it starts at, and when the last `R` frames sent to it that carried a change it
lacked are all lost it did not. The state is the same from a send's state frame to the send, so a
client that received the send holds the base, and when the traffic is sparse a lost frame is absorbed
by the next frame sent, however long the quiet stretch between them. A frame that carried nothing the
client lacked, a keepalive or the repeat of a change it already holds, names the state frame of the
change before it, so losing it never moves the next delta past what the client holds. The client holds
the diff it cannot apply, reports the gap in its next ack, and the server sends plain deltas from the
ack until the client has caught up. The client's view stops for about one round trip. Its
interpolation buffer hides part of that. A change lost with nothing sent after it is found by a timer
instead, the same twice-the-smoothed-round-trip timeout that presumes a baseline lost, and costs
that timeout plus a link delay. If a delayed ACK covers the watched change but newer sent content
is still unacknowledged, the timer immediately retargets to that tail. See the
[liveness bound and probe design](../../../architecture/REPLICATION.md#liveness-the-ack-timeout).

| `redundancyFrames` | A change is sent in           | Lost frames in a row that stall the view |
| ------------------ | ----------------------------- | ---------------------------------------- |
| unset              | every frame until it is acked | none: the next frame repeats it          |
| 1                  | 1 frame                       | 1                                        |
| 2                  | 2 consecutive frames          | 2                                        |
| 3                  | 3 consecutive frames          | 3                                        |

The server is optimistic only while a session is healthy: its baseline is acked, none is in flight,
no fallback is running and its ack is not overdue. A baseline and everything around it work exactly
as described above. Pick the smallest `R` whose stalls your players accept: on a link with 5% loss
each way, 2 stalls the view about four times a minute and 3 almost never. The mechanism, the
fallbacks and the measured trade-off are in
[Replication](../../../architecture/REPLICATION.md#the-optimistic-base).

### Keepalive: `keepAliveFrames`

Use `world.keepAliveWhile(dsl)` before the first session to pause
idle keepalives once nothing visible matches and the last content send is acknowledged.
It requires `keepAliveFrames`; registrations OR their queries.
No registration preserves the existing cadence
and bytes. See [the gate, clock contract, and cost](../../../architecture/REPLICATION.md#pause-idle-sessions-with-a-gate).

The server sends a session nothing for an empty diff, so while a view is quiet no frame reaches
the client and its `renderFrame` holds at the newest frame it applied. The replicated data is
right, because nothing changed. But whatever the client derives from `renderFrame` instead of from
data stands still with it, and jumps when the next frame arrives. Dead reckoning is the case that
matters: a body is extrapolated at `renderFrame`, so in an idle scene it freezes and then jumps.
In a Space Rocks sector with a parked ship and drifting rocks that was holds of up to 3.5 s and
jumps of about 3 m. A scene that changes on every tick sends a frame every tick and never notices.

`keepAliveFrames` sets `K`: a session that holds an acked baseline and has not been sent a frame
with a diff for `K` frames is sent one whose diff is empty.

```ts
const world = new ServerWorld({
  name: "arena",
  networkComponents: [Position],
  keepAliveFrames: 1,
});
```

It is off by default, and then the wire is byte for byte what it always was. `K` must be an integer
of at least 1; the constructor throws for anything else, and `world.keepAliveFrames` reads the value
back, which is how `DeadReckonedModule` checks at install that the world sets it. Use `1`: the
client's `renderFrame` then advances on every tick. Larger values send fewer frames, and the
client's `renderFrame` waits for each one. Its interpolation buffer spans one missing frame on a
steady link, so `2` still looks smooth there, but from `3` on the render frame stalls between
keepalives and jumps when the next arrives.

A keepalive is an ordinary frame with an empty diff, so everything else follows from the rules above:

- **It is labeled like any frame.** It starts at the base the frame would have had anyway, the ack or,
  with `redundancyFrames`, the optimistic base, and carries the optimistic marker when that is past
  the ack. The client applies it, its version advances, and it acks it like any frame.
- **It counts as a send** for the optimistic base, because the client was sent it and its version may
  be that frame, with the state frame of the session's last change. It carries nothing, so it names
  the frame the send before it named, and a lost keepalive can never be the base of a later frame that
  the client cannot apply. An idle view whose last change is acked has a base at or before its ack:
  its keepalives are plain deltas from the ack, the same bytes whatever `R` is, and on a link with 5%
  loss each way it reports no gaps at `R` 1, 2 or 3. It is **not content** for the ack timeout, so a
  lost keepalive is never chased with a fallback: nothing in it needs delivering.
- **It is never sent while a baseline is in flight or needed**, and not before the client has acked
  a baseline: the rules above hold, and the session is sent no state. A frame that carries only
  RPC traffic, as then, has no diff, advances no `renderFrame` and does not restart the count. A
  frame that carries RPC traffic with an empty diff does, because the client applies the diff.
- **A busy session is unaffected.** A frame with a diff of any kind restarts the count, so a session
  that is sent a diff at least every `K` frames is sent exactly what it is sent without the option.

It costs a header-only frame per `K` ticks for each session that would otherwise be sent nothing:
5 bytes of payload below frame 128, 7 below 16 384 (about nine minutes at 30 Hz), 9 below two million
(about 19 hours) and 11 beyond, plus 1 when marked optimistic. At 30 Hz and `K` 1 that is about
150 to 330 payload bytes per second per idle client, excluding transport and ACK overhead. The client must
understand nothing new: an empty diff is a diff, so older clients accept the frames. The mechanism
and the measured cost are in [Replication](../../../architecture/REPLICATION.md#the-keepalive).

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
world.handleRpc("auth", (params, _request, ctx) => {
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

## Calling a client

Use `world.invoke(connectionId, rpcId, params = [], ttl = 5000)` to call a handler
registered with `ClientWorld.listen`. It resolves with the reply's parameters,
not an RPC wrapper. Requests travel in server frames and the client's handler
runs from `apply()` (normally `ON_LOAD` in `progress()`); the reply travels in its
next ack. Keep both worlds' network loops running while awaiting the result.

```ts
const [answer] = await world.invoke(connectionId, 201, ["question"], 5000);
```

Unknown or closing connections reject immediately with `RPC_CLOSED_CODE`.
Handler failures preserve their wire-safe `RPCError` code and message. Session
teardown rejects outstanding calls with `RPC_CLOSED_CODE`; an unanswered call
expires with `RPC_TIMEOUT_CODE` on the first `send()` at or after its deadline
(`performance.now()` at invocation plus the unchanged TTL). Every session with pending
outgoing calls is checked, including sessions without a `View`; sessions only answering
client requests do not tick RPC. There is no additional timer: pausing the loop delays
expiration until the next send. `rpcTickMs` and its TTL compensation have been removed.
See [protocol deadline semantics](../../vecs-protocol/docs/rpc.md#timeouts-and-aborts).

## Reference

| Member                                             | Description                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.handleRpc(rpcId, handler)`                  | Register a handler for every session, now and later.                                                                                                                                                                  |
| `world.invoke(connectionId, rpcId, params?, ttl?)` | Call a client and resolve with reply params; reject on error, timeout or session end.                                                                                                                                 |
| `world.closeSession(connection, reason?, code?)`   | Gracefully close one session by connection id or `NetworkClient` entity, telling the client the reason and code. Returns whether it was scheduled.                                                                    |
| `world.shutdown(options?)`                         | Gracefully close every session, flush until gone or `timeoutMs`, close listeners. Idempotent.                                                                                                                         |
| `world.send()`                                     | Advance one replication frame, sending each session a delta, a baseline, or nothing; called by `progress()`.                                                                                                          |
| `ServerRPCContext`                                 | `{ world, caller, connectionId }` passed as a handler's third argument.                                                                                                                                               |
| `NetworkClient.id`                                 | The connection id.                                                                                                                                                                                                    |
| `NetworkClient.closeReason`                        | Why the server closed the session, or `undefined`.                                                                                                                                                                    |
| `CLOSE_PROTOCOL_ERROR_CODE`                        | Reserved close code `1`: the session was closed because a frame could not be decoded. Also exported by `@vworlds/vecs-protocol`.                                                                                      |
| `closeLingerMs` (`ServerWorldOptions`)             | Bound on how long a closing session waits for the ack of its reply flush before the transport closes.                                                                                                                 |
| `historyFrames` (`ServerWorldOptions`)             | Frames of history each session keeps: how far behind its ack can be, while its view keeps changing, and still get a delta. Integer of at least 2; default 64.                                                         |
| `redundancyFrames` (`ServerWorldOptions`)          | Opt in to the base at the state frame `redundancyFrames` sends ago, never before the ack: a change goes out in that many sends, not in every frame until acked. An integer in [1, `historyFrames`); unset by default. |
| `keepAliveFrames` (`ServerWorldOptions`)           | Opt in to a frame with an empty diff for a session that was sent no diff for that many frames, so the client's `renderFrame` keeps moving in an idle scene. An integer of at least 1; unset by default. `1` is safe.  |
| `world.keepAliveFrames`                            | The configured `keepAliveFrames`, or `undefined`.                                                                                                                                                                     |
| `networkEntityReuseWaitFrames`                     | Frames a destroyed entity's id waits before another entity can take it; never fewer than `historyFrames + 1`. Non-negative integer; default 16, so 65 by default.                                                     |

Per-symbol detail lives in the JSDoc on `lib/vecs-server/src/server_world.ts`,
`lib/vecs-server/src/history.ts` (the window), `lib/vecs-server/src/rtt.ts` (the ack round-trip
estimate) and `lib/vecs-server/src/networked.ts`. The replication design behind them is in
[Replication](../../../architecture/REPLICATION.md).

## See also

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [Client world](../../vecs-client/docs/client-world.md) — the browser side, including disposal.
