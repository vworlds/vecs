# State diffs

How a `StateDiff` describes a change, the order a client must apply it in, and why that order is
what keeps an entity id that the server reuses from meaning the wrong entity.

## What you'll learn

- What a diff and a baseline carry.
- The order a diff means, and what a diff with a removal and snapshots of one id tells the client.
- Which part of the stack keeps that order, and what an overlapping delta costs.
- How the server's id quarantine keeps the case rare, and why clients deploy before servers.

## The shape of a diff

A `StateDiff` (`lib/vecs-protocol/src/messages.ts`) takes a client from one frame to another:

| Field       | Meaning                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fromFrame` | The frame the client must hold for the diff to apply. `0` makes the diff a **baseline**: the whole view as of `toFrame`.            |
| `toFrame`   | The frame the client holds once it has applied the diff.                                                                            |
| `snapshots` | The new value of a component. A snapshot creates the entity if the client does not hold it.                                         |
| `removed`   | `[eid, wireType]` pairs. A wire type of `ALL_COMPONENTS` (`0`) removes the whole entity; any other wire type removes one component. |

A delta merges every frame after the client's acked frame. A diff for one frame and a delta that
spans a dozen are the same kind of value, so everything below holds for both.

## The order a diff means

The lists carry no order of their own. A diff means this one, and every producer and consumer of a
diff keeps it:

1. the `ALL_COMPONENTS` removals;
2. the snapshots;
3. the removals of single components.

So `ALL_COMPONENTS` for an eid precedes every snapshot of that eid in the same diff. The server
reuses the id of a destroyed entity, and the wire carries no entity generation, so this is how a
client tells the old entity from the new one:

| `removed` has         | `snapshots` has | The client ends up with                                                      |
| --------------------- | --------------- | ---------------------------------------------------------------------------- |
| `[N, ALL_COMPONENTS]` | nothing for `N` | no entity `N`                                                                |
| `[N, ALL_COMPONENTS]` | some for `N`    | a **new** entity `N` with exactly those components and none of the old one's |
| nothing for `N`       | some for `N`    | entity `N` updated in place, or created if it was absent                     |
| `[N, c]`              | nothing for `c` | entity `N` without `c`                                                       |

The second row is the case to know: the diff tells the client that the entity it holds under `N` is
gone and a new one has taken the id. The client destroys the old entity first, so its hooks run,
its client-local components and edges go with it, and the new entity is built from nothing and
fires its own `add` hooks and `enter` events. A consumer that applied the snapshots first would
build the new entity and then destroy it.

## Who keeps the order

| Where                        | What it does                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerWorld.send`           | Records, per session and frame, the exits of its view as `ALL_COMPONENTS` and the entities that entered as snapshots. A frame can hold both for one id, when an id is reused at once.                                                                                     |
| `History.pull` (server)      | Merges the frames after the client's ack, keeping the order inside each frame. An entity removed and snapshotted again within the span is pulled as a **reset**: `ALL_COMPONENTS` plus its current snapshots. A span that starts after the removal pulls snapshots alone. |
| `DiffBuffer.merge` (client)  | Joins frames the client buffered, with the same rule. A later `ALL_COMPONENTS` for an eid drops the earlier snapshots and single removals of it; snapshots of an eid keep an earlier `ALL_COMPONENTS`. Interpolation never blends a new entity from the one it replaced.  |
| `ClientWorld.apply` (client) | Destroys the entities `ALL_COMPONENTS` removes, then applies the snapshots, then the removals of single components. See [Client world](../../vecs-client/docs/client-world.md#applying-a-diff).                                                                           |

A reset also covers an entity that left a session's view and came back inside one delta. Without
it, the delta would hold the entity's snapshots alone, and a client that never saw it leave would
keep the components it lost while out of sight.

## Overlapping deltas rebuild the entity again

A delta starts at the newest frame the server has seen acked, so while an ack is in flight the next
delta overlaps the one before it. Each delta whose span includes the removal repeats the reset: a
client whose acks lag by three frames rebuilds the entity up to three times in a row, once per
delta, before its ack passes the removal. Its final state is right every time. What repeats is the
rebuild: the entity's `exit` and `enter`, and whatever client-local state hangs off them.

This needs an id to be removed and snapshotted again within the client's ack lag, which the server's
id quarantine keeps from happening for a reused id. Only an entity that leaves a view and returns
within the lag still takes it.

## Reusing an id

A `ServerWorld` holds the id of a destroyed entity for at least `historyFrames + 1` frames before it
hands it out again (`networkEntityReuseWaitFrames`, see
[Sessions](../../vecs-server/docs/sessions.md#reusing-entity-ids)). By then the frame that removed
the old entity has left every session's history, so a client that has not acked it is sent a baseline
instead of a delta, and no delta has to hold both entities. The order above is the safety net under
that policy: it keeps the handover right for a world configured with no wait, for a client that
buffers frames while it is not rendering, and for an entity that returns to a view.

## Compatibility

Deploy clients before servers. A client built before this order applies the snapshots first, so it
destroys the new entity of a diff that holds `ALL_COMPONENTS` and snapshots for one id, which a
server now sends to a lagging client. A new client applies every diff an older server sends
correctly: the order only changes the meaning of a diff that holds both, and an older server did not
send one on its default settings.

## See also

- [Client world](../../vecs-client/docs/client-world.md) — applying diffs, baselines, and `reset`.
- [Sessions and caller context](../../vecs-server/docs/sessions.md) — the history window, baselines,
  and the id quarantine.
- [Id pools](../../vecs/docs/components.md#id-pools) — how entity ids are allocated and reused.
