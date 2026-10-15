# Watches and resources

Follow reactive world changes without repeating a one-shot query.

## Create and read a watch

Call `vecs_watch` with the same JSON `where` DSL as
[`vecs_find`](./tools.md#query-dsl), plus optional `include` names and a positive
integer `maxEvents` (default 1000). The result is `{ watch, members }`.
Unlike find, watches reject **`source` and `children` anywhere in `where`**, including
nested expressions: those operators are filter-only and non-reactive in vecs.
The error names the operator and directs you to `vecs_find`. `parent`, `target`
and the other reactive operators remain supported; no polling fallback is installed.
`members` counts current matches; creating the watch emits no backfill events.
Use a one-shot find when you need the initial entity values. `include` selects
optional values and update hooks only: it never requires those components for
membership. Duplicate include names install only one hook.

Read `vecs_events({ watch, since: 0, limit: 100 })`. Events have `seq > since`,
oldest first, up to the nonnegative integer `limit`. Pass the last consumed `seq`
as the next cursor; `latest` describes the log head, not necessarily the last
event on a limited page. Sequence numbers start at 1 and increase per watch.

| Event    | Fields beyond `seq`, `kind`, `eid`, optional `name`                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| `enter`  | `value` is an object keyed by included component name, containing those present at entry; omitted with no includes |
| `update` | `component` is the included name, `value` its serialized component data                                            |
| `exit`   | No component data                                                                                                  |

Values follow the existing [serialization and opacity policy](./execution.md#values-and-opacity)
and are snapshots taken during the callback, not references to mutable data.

The ring holds at most `maxEvents` events. Overflow discards the oldest and
increments cumulative `dropped`; if nonzero, re-find to reconcile missing state.
`vecs_unwatch({ watch })` destroys the query, removes its hooks and frees the log.
All three tools also accept `target?` and work on read-only nodes.

## Lifetime and cost

Each watch belongs to its creating MCP session. DELETE, server shutdown or session
idle close releases its watches. Independently, 30 minutes without a successful
`vecs_events` or resource read expires a watch, even while writes arrive or its
session remains active. The next event/resource read of that id returns
`{ events: [], latest: 0, dropped: -1 }` once, then the id is forgotten.
A world accepts at most 32 live watches across all sessions; the 33rd is rejected
with the list of live ids. Expired watches no longer consume that cap.

There is no per-tick work. With no watches, no watch queries, update watchers or
component hooks are registered. Each watch adds one membership query plus one
removable `set` hook for each distinct included component. Each write of that
component anywhere in the world costs one membership check per watching hook;
matched changes allocate serialized events. Unrelated component writes install
no update routing. Teardown restores query count and the original hook list.

Hooks observe `set`, `attach`, `getMut`, `ensure` and `modified` through the normal
component `set` notification. Two `set` calls produce two events, even in one
tick; repeated pending `modified` calls coalesce as usual. A plain `add` produces
membership entry, not an update hook. Sequence order guarantees **callback delivery
order**, not a transaction boundary or a universal enter-before-update ordering:
hooks run synchronously, while membership callbacks follow query routing. The
tested simple component predicate emits enter then update for a new entity's
deferred set; do not rely on that order for other predicates or reentrant hooks.

## Subscribe to local resources

`resources/list` exposes only the calling session's live local watches as
`vecs://<node>/<world>/watch/<id>` (node/world path segments are percent-encoded).
`resources/read` returns JSON with the same payload as `vecs_events` at
`since = 0`, default `limit = 100`; it refreshes the watch's idle deadline.

Subscribe with `resources/subscribe` and keep the session's GET stream open.
Incoming events schedule `notifications/resources/updated` with the resource URI,
coalesced into at most one notification per 100 ms per subscription. Read the
resource or use a cursor-based event read to consume the data. Notifications do
not themselves extend the watch lifetime. `resources/unsubscribe` cancels pending
notifications. A removed watch no longer appears in listings.

Remote watches routed through links or tunnels are **pull-only** in this card:
use the three tools, not local resource listings, reads or subscriptions. Watch
ownership travels in the bridge request, and session teardown attempts remote
unwatch as well; the remote idle deadline bounds cleanup if the route is lost.
