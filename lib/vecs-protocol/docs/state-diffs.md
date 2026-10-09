# State diffs

How a `StateDiff` describes a change, the order a client must apply it in, and why that order, with
the frame a reset carries, is what keeps an entity id that the server reuses from meaning the wrong
entity.

## What you'll learn

- What a diff and a baseline carry.
- The order a diff means, and what a diff with a reset and snapshots of one id tells the client.
- Why a reset carries the frame it happened at, and how the client applies it exactly once.
- Which part of the stack keeps the order and the idempotence.
- How the server's id quarantine keeps the case rare, how a diff travels on the wire, and why
  clients deploy before servers.

## The shape of a diff

A `StateDiff` (`lib/vecs-protocol/src/messages.ts`) takes a client from one frame to another:

| Field       | Meaning                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `fromFrame` | The frame the client must hold for the diff to apply. `0` makes the diff a **baseline**: the whole view as of `toFrame`.    |
| `toFrame`   | The frame the client holds once it has applied the diff.                                                                    |
| `snapshots` | The new value of a component. A snapshot creates the entity if the client does not hold it.                                 |
| `removed`   | `[eid, wireType]` pairs: the single components that are gone. A wire type is never `ALL_COMPONENTS` here.                   |
| `resets`    | `[eid, frame]` pairs: the entities that are gone altogether, each with the server frame at which it left the client's view. |

A reset is the removal of a whole entity: it was destroyed, lost its `Networked` component, or went
out of the session's view. A delta merges every frame after the client's acked frame. A diff for one
frame and a delta that spans a dozen are the same kind of value, so everything below holds for both.

## The order a diff means

The lists carry no order of their own. A diff means this one, and every producer and consumer of a
diff keeps it:

1. the resets;
2. the snapshots;
3. the removals of single components.

So a reset of an eid precedes every snapshot of that eid in the same diff. The server reuses the id
of a destroyed entity, and the wire carries no entity generation, so this is how a client tells the
old entity from the new one:

| `resets` has | `snapshots` has | The client ends up with                                                      |
| ------------ | --------------- | ---------------------------------------------------------------------------- |
| `[N, f]`     | nothing for `N` | no entity `N`                                                                |
| `[N, f]`     | some for `N`    | a **new** entity `N` with exactly those components and none of the old one's |
| nothing      | some for `N`    | entity `N` updated in place, or created if it was absent                     |

A removal `[N, c]` in `removed` takes component `c` off entity `N` after all of that.

The second row is the case to know: the diff tells the client that the entity it holds under `N` is
gone and a new one has taken the id. The client destroys the old entity first, so its hooks run, its
client-local components and edges go with it, and the new entity is built from nothing and fires its
own `add` hooks and `enter` events. A consumer that applied the snapshots first would build the new
entity and then destroy it.

## A reset applies once

A delta starts at the newest frame the server has seen acked, so while an ack is in flight the next
delta overlaps the one before it. Each delta whose span includes a removal repeats the reset. If a
client applied every repeat, an entity that left a view and came back within the client's ack lag
would be destroyed and rebuilt once per delta, with its `exit` and `enter` hooks and its client-local
state repeating each time.

So a reset carries the frame at which it happened, and the client applies it only if that frame is
**newer than the frame the client held before the diff**. Otherwise it applied the reset already, in
an earlier delta, and skips it: the snapshots and removals that follow update the entity in place.
Whatever the ack lag, the client rebuilds the entity once, as a client that acks at once does.

A removal of a single component made **after** a reset stays in the diff, next to the reset and the
snapshots. A client that applies the reset finds nothing left to remove, but one that skips it needs
the removal. Take an entity that was reset at frame 5, gained a component at frame 6 and lost it at
frame 7. A client that holds frame 6 has the component, and a delta that spans frames 4 to 7 must
take it away:

| The client holds | It does with the reset at frame 5 | It ends up with                                      |
| ---------------- | --------------------------------- | ---------------------------------------------------- |
| frame 4          | applies it: destroys the entity   | the new entity, without the component                |
| frame 6          | skips it: it has applied it       | the same entity, with the component removed in place |

## Who keeps the order and the idempotence

| Where                        | What it does                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ServerWorld.send`           | Records, per session and frame, the exits of its view as resets carrying the frame, and the entities that entered as snapshots. A frame can hold both for one id, when an id is reused at once.                                                                                                                                |
| `History.pull` (server)      | Merges the frames after the client's ack, keeping the order inside each frame. An entity reset within the span keeps its **newest** reset, with its frame, and the snapshots and removals that follow it; what the span did to the entity before is dropped. A span that holds no reset of the entity pulls its changes alone. |
| `DiffBuffer.merge` (client)  | Joins frames the client buffered, with the same rule: the newest reset frame of each eid wins, a reset newer than the other diff's drops that diff's snapshots and removals of the eid, and snapshots of an eid keep an earlier reset. Interpolation never blends a new entity from the one it replaced.                       |
| `DiffBuffer.pull` (client)   | Hands out only the resets whose frame is newer than the state the pull starts from, which is the version the world held before the diff. The ones it drops were applied already.                                                                                                                                               |
| `ClientWorld.apply` (client) | Destroys the entities the diff resets, then applies the snapshots, then the removals of single components. See [Client world](../../vecs-client/docs/client-world.md#applying-a-diff).                                                                                                                                         |

A reset also covers an entity that left a session's view and came back inside one delta. Without it,
the delta would hold the entity's snapshots alone, and a client that never saw it leave would keep
the components it lost while out of sight.

## Reusing an id

A `ServerWorld` holds the id of a destroyed entity for at least `historyFrames + 1` frames before it
hands it out again (`networkEntityReuseWaitFrames`, see
[Sessions](../../vecs-server/docs/sessions.md#reusing-entity-ids)). By then the frame that removed
the old entity has left every session's history, so a client that has not acked it is sent a baseline
instead of a delta, and no delta has to hold both entities. The order above is the safety net under
that policy: it keeps the handover right for a world configured with no wait, for a client that
buffers frames while it is not rendering, and for an entity that returns to a view.

## On the wire

`Server2Client` carries a diff without resets as field 1, in the layout diffs have always had. A diff
with resets goes as field 6: the same layout followed by a count and, for each reset, two varints,
the eid and `toFrame - frame`. The frame travels as its distance from `toFrame`, which is at most the
history window, so a reset costs a few bytes: the same as the removal it replaced, plus one byte for
the count in a diff that has any.

## Compatibility

Deploy clients before servers.

- A server that sends resets uses field 6 only for a diff that holds one. A client built before
  resets rejects it as an unknown field tag and closes with the protocol-error code, so an old client
  fails loudly on the first entity that leaves a view, not silently.
- A new client reads field 1 from an older server as before. It takes a removal with wire type
  `ALL_COMPONENTS` in the `removed` list as a reset at the diff's `toFrame`, which always applies, as
  such a removal always did: an older server's removal carries no frame to compare.

## See also

- [Client world](../../vecs-client/docs/client-world.md) — applying diffs, baselines, and `reset`.
- [Sessions and caller context](../../vecs-server/docs/sessions.md) — the history window, baselines,
  and the id quarantine.
- [Id pools](../../vecs/docs/components.md#id-pools) — how entity ids are allocated and reused.
