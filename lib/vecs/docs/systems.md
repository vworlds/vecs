# Systems

Build systems: declare membership, react to entities entering, changing, and leaving, run per-tick
logic, control cadence, and inject components into callbacks.

## What a system is

A `System` (`lib/vecs/src/system.ts`) is a reactive processor over a filtered subset of world
entities. It extends [`Query`](./queries-and-filters.md), so membership, `enter`/`exit`/`update`
callbacks, sorting, and tracking are shared — and adds pipeline integration: a phase slot, an
event **inbox** replayed once per tick, plus `run` and `each` callbacks.

Create systems through the world and configure them with a fluent builder (every method returns
`this`):

```ts
world
  .system("Render")
  .with(Sprite, Position)
  .enter([Sprite, Position], (e, [sprite, pos]) => sprite.show(pos))
  .update({ watch: Position, onEnter: true, inject: [Sprite] }, (e, pos, [sprite]) =>
    sprite.moveTo(pos.x, pos.y)
  )
  .exit([Sprite], (e, [sprite]) => sprite.hide());
```

Newly created systems enter the pipeline the next time `world.progress` runs. Configuration must
happen before the system is built (the first `progress`/`flush` after creation); builder calls
after that throw. Reading `world.pipeline` between frames also builds pending queries.

Idle systems avoid entering a deferred callback scope when their inbox is empty,
they have no `run` callback, and any `each` query has no members. Cadence and injection
clocks still advance normally, and due systems still count in stats. Events routed
by an earlier system and new query members are processed in the same frame when
the system is due. A `run` callback always executes when enabled and due, even
without members or component changes.

## Measuring systems

Enable opt-in synchronous timing for benchmarks, cadence guards, or live diagnostics:

```ts
world.stats.enableSystems();
world.progress(1000, 16);
for (const { system, runs, totalMs, maxMs } of world.stats.systems()) {
  console.log(system.name, runs, totalMs, maxMs);
}
world.stats.resetSystems(); // clear system and extension-operation totals
world.stats.disableSystems(); // stop measuring; retain results until reset
```

Timing is off by default. `progress()` chooses the plain or instrumented loop once per tick;
the plain loop has no per-system timing branch, counter, or clock read. The instrumented loop
uses one `performance.now()` pair per pipeline entry and reuses first-seen slots.

`systems()` returns independent snapshots in current pipeline order, including systems with zero
runs. Each row holds the original `System`, not copied identity or cadence metadata. Newly
registered systems appear after the next pipeline refresh in `progress()`. Removed systems are
absent. Reading does not reset the totals.

A run means execution admitted by the system's enabled and tick-source gates, not a callback or
entity count: an idle reactive system or an empty `each` query still counts when due. Disabled
and cadence-skipped entries contribute neither runs nor time. For an admitted execution, timing
includes inbox processing, callbacks, and **the flush after that system**, including command
routing and hooks. Initial frame preparation and final frame closure are not attributed. An
execution that throws before completing its flush does not contribute a completed run.

Extensions expose breakdown rows through `world.stats.operations()`, under the same switch and
reset. See [ServerWorld replication timing](../../vecs-server/docs/replication-timing.md).
Reading either table allocates snapshots; normal measured ticks reuse slots. Reset keeps slots
and clears totals, including systems temporarily absent from the pipeline.

When implementing a world extension, choose the measured path once per frame with
`stats.systemsEnabled`, then call `stats.recordOperation(name, elapsedMs)` once per completed
operation. It aggregates a finite, non-negative duration into a reusable named slot. This method
does not read a clock or recheck the switch; it lets an already-measured frame complete even if
a callback disables future timing. Invalid durations throw `RangeError`.

## Membership: `with` / `without`

`.with(...)` declares which entities the system tracks. It accepts component classes, arrays, and
the full query DSL (operator semantics in
[Queries and filters](./queries-and-filters.md#the-query-dsl)):

```ts
.with(Position, Velocity)                                 // all listed components
.with([Position, Velocity])                               // array shorthand
.with({ all: [Position, { any: [Sprite, Container] }] })  // compound DSL
.with({ not: Invisible })
.without(Invisible)                                       // shorthand for .with({ not: Invisible })
.with({ target: [FriendOf, Position] })                   // any relationship target has Position
.with({ parent: Body })                                   // ChildOf target has Body
```

`.without` is not free: see [its cost](./queries-and-filters.md#the-cost-of-not-and-without).
Multiple `with` calls merge with `all`. The `source` / `children` operators are non-reactive and
rejected by systems — they are filter-only (see
[Queries and filters](./queries-and-filters.md#filters-one-shot-scans)).

**Type inference.** Components that `with()` can see statically (plain classes, arrays, `all`,
`only`) become non-nullable in `orderBy`, `each`, `forEach`, and `update` injection tuples. For
DSL shapes the type system can't introspect (`any`, `not`, `test`, …), supply a `hint`:

```ts
.with({ with: { any: [Position, Velocity] }, hint: [Position] })
.each([Position], (e, [pos]) => pos.x);
```

`hint` is type-level only — it is not validated at runtime.

## Phase placement

Systems default to the `vecs::OnUpdate` phase. `.phase(anchor)` moves the system after another
pipeline anchor, by name, constant, or entity:

```ts
.phase(ON_LOAD)                  // a built-in phase constant
.phase("physics-step")           // a custom anchor, created and tagged Phase if missing
.phase(world.entity("anchor"))   // an existing entity
```

A system lives in exactly one phase; calling `.phase` again replaces the previous placement. Phase
taxonomy, ordering rules, and custom phases are covered in
[Execution model](./execution-model.md#phases-the-pipeline-spine).

## Reactive callbacks: `enter`, `update`, `exit`

Mutation events are routed into the system's inbox as the world applies commands; the inbox is
replayed in arrival order at the top of the system's next run, inside a deferred scope.

### `.enter(callback)` / `.enter(inject, callback)` / `.enter(options, callback)`

Fires once when an entity starts matching the system:

```ts
.enter((e) => { ... })
.enter([Position, Sprite], (e, [pos, sprite]) => sprite.setPosition(pos.x, pos.y))
.enter({ inject: [Position, Sprite] }, (e, [pos, sprite]) => sprite.setPosition(pos.x, pos.y))
```

The callback runs only if the entity is still a member when this system drains its inbox, at the top
of its next run. The inbox replays in arrival order, so:

- An entity that left the query or was destroyed first gets no `enter`, and in a system that
  registers both callbacks no paired `exit` either. Do not add a `destroyed` guard to normal `enter`
  setup code. A system with only `exit` has no `enter` to pair, so it still gets that `exit`.
- An entity that leaves and re-enters before the drain is a member again, so the system gets
  `enter`, `exit`, `enter` (just `exit`, `enter` when it had already entered in an earlier drain).
  Keep `enter` setup and `exit` teardown symmetric so the second `enter` starts from a clean state.

For systems, injected values and `Iter.src` are captured when entry is routed and replayed from that
snapshot when the system next drains its inbox.

### `.update(ComponentClass, callback)` / `.update(options, callback)`

Fires when the watched component is set or marked modified on a tracked entity.
`update(ComponentClass, ...)` also adds `ComponentClass` to the membership predicate, so the system
only matches entities that carry the watched component. Pass `{ onEnter: true }` in the options form
when the callback should also run as an entity enters with the watched component already present.
The callback receives the entity first because component instances carry no owner reference:

```ts
.update(Position, (entity, pos) => renderer.setPosition(entity.eid, pos.x, pos.y))
.update({ watch: Position, onEnter: true, inject: [Sprite] }, (entity, pos, [sprite]) =>
  sprite.setPosition(pos.x, pos.y)
)
```

Use `onEnter: true` for "apply current value when the entity appears, and again on change". Without
it, `update` is change-only and a separate `enter` callback can own initialization.

Because `update` adds `watch` to the membership predicate, `add(C)` can be the operation that makes
an entity enter. Choose one update callback for `C`: `update({ watch: C, onEnter: true }, cb)` fires
`cb` with the freshly added component, while `update(C, cb)` tracks the new member but waits for a
later `set` or `modified`.

Use `.update(C, ...)` by itself when `C` is the membership shape and watched value. Use
`.with(A).update(C, ...)` when the callback should run only for entities carrying both `A` and `C`.

A query or system can register only one `update(C, ...)` callback for each component. A duplicate
registration throws instead of replacing the existing callback.

#### Repeated writes in one tick

Each routed write is one `update` event, and a system's inbox replays its events in arrival order
without merging any (`lib/vecs/src/system.ts`, `_pushUpdate` and the drain loop in
`_runDeferred`). What differs is how many events a write routes:

| Write                      | Events routed for `C` in one drain window                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `entity.set(C, …)` × n     | n: every call queues its own command and fires its own `onSet` and `update`                      |
| `entity.modified(C)` × n   | 1: the first call sets the dirty bit, the command clears it when it runs, later calls are no-ops |
| `entity.getMut(C, cb)` × n | 1: it marks modified through the same dirty bit                                                  |

Coalescing needs a queued command, so it applies to calls made while commands are deferred (inside
system callbacks); outside them `modified` applies immediately. To get one callback per tick, write
in place and call `modified` (or use `getMut`), or compare before `set` and skip equal values. Do
not add a per-tick dedupe or batching step in the consumer when producers already use
`modified`/`getMut`. Source: `lib/vecs/src/entity/entity.components.ts` (`_markModified`, `set`,
`_notifyRaw`).

### `.exit(callback)` / `.exit(inject, callback)` / `.exit(options, callback)`

Fires when an entity stops matching (component removed, or entity destroyed). Directly injected
components and relationship projections are read from a **snapshot captured at exit time**, so
the same component and entity references remain available even if storage or edges change before
the system drains its inbox. Component objects are not cloned; later in-place changes to the same
object remain visible:

```ts
.exit([Sprite], (e, [sprite]) => sprite.destroy());
.exit({ inject: [Sprite] }, (e, [sprite]) => sprite.destroy());
```

## Per-tick callbacks: `each` and `run`

### `.each(components, callback)` / `.each(options, callback)`

Fires every tick the system runs, once per tracked entity, regardless of change. Use it only for
genuinely per-frame sweeps — when reacting to change suffices, prefer `update`. An `.each` must
justify running every tick, and when it does, narrow `.with(...)` to a tag that exists only while
the work is live (see
[Design guide](./design-guide.md#each-vs-reactive--dont-scan-when-you-can-react)):

```ts
.with(Position, Velocity)
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});

.each({ inject: [Position, Velocity] }, (e, [pos, vel]) => {
  pos.x += vel.vx;
});
```

`each` implies `.track()`. Only one `each` per system — a second call throws. The resolved tuple
array is reused across entities; read it inside the callback, don't retain it.

### `.run(callback)`

Fires once per tick when the system's phase runs, regardless of entity membership. Use it for
polling, network I/O, stepping an embedded simulation:

```ts
.run((now, delta) => {
  sendNetworkPacket(now);
});
```

`now` is the absolute timestamp passed to `progress`; `delta` is milliseconds since the previous
tick — or, when the system has a cadence source, the milliseconds accumulated since this system
last fired.

Within one system run the order is: inbox replay (`enter`/`exit`/`update` events), then `run`,
then `each`.

## Component injection

`enter`, `exit`, `update`, `each`, `orderBy`, and `forEach` accept either a short injection list or
an options object with `inject`, resolved per entity and passed as a typed tuple:

```ts
.each([Position, Sprite], (e, [pos, sprite]) => { ... })
.each({ inject: [Position, Sprite] }, (e, [pos, sprite]) => { ... })
```

Inject every component a callback always uses, and keep `entity.get` for one that is only
conditionally needed (see [Design guide](./design-guide.md#injection)).

Nullability follows membership: components guaranteed by `with` (or `hint`) are non-nullable;
anything else resolves as `T | undefined` — guard it. (`enter`/`exit` injection requires the
direct components to be present and throws otherwise; list only components your predicate
guarantees.)

### Clock injection

Import `Now` and `Delta` from `@vworlds/vecs` and include them in a system's `each`, `update`,
`enter`, or `exit` inject list. Both resolve to non-optional `number` slots regardless of `.with`.
Mix them freely with direct components and `target`, `targets`, or `down` injects, in any position:

```ts
import { Now, Delta, Iter } from "@vworlds/vecs";

world
  .system("Stamp")
  .with(Position)
  .update(
    { watch: Position, onEnter: true, cursor: Iter, inject: [Now, Position, Delta] },
    (it, position, [now, injectedPosition, delta]) => {
      console.log(it.entity.eid, position === injectedPosition, now, delta);
    }
  );
```

`Now` is the timestamp passed to the system's processing tick, **not** the time the mutation was
made. `Delta` is that system's own tick delta in milliseconds, the same value its `run` callback
receives. An interval, rate, or upstream tick source accumulates time between fires; it does not
inject the last frame's delta. Deferred enter/exit snapshots retain component references, but
clock slots are filled at replay from the processing tick, even if the entity died in an earlier
frame.

Clock tokens are supported only in the four system callback kinds above. Standalone query
callbacks and synchronous iteration/ordering/grouping have no processing clock: TypeScript
rejects tokens there, and bypassing the types throws a clear error at registration. With
`cursor: Iter`, clock slots have `undefined` sources in `it.src`; time remains in the inject tuple.
Tuple lifetimes are unchanged: `each`/`update` reuse their tuples, while `enter`/`exit` give each
event its own tuple.

### Relationship injection

`{ target: [Rel, projection] }` follows the entity's **first** relationship target and flattens the
projection into the callback tuple. Use a component class to inject one target-side component, use
`Entity` to inject the target itself, or use a tuple to inject several values in order:

```ts
.enter([{ target: [FriendOf, Entity] }], (source, [friend]) => {
  // friend is source.target(FriendOf), one current target, or undefined.
});

.forEach([Body, { target: [FriendOf, Position] }], (source, [body, pos]) => {
  // body is from source; pos is from source.target(FriendOf).
});

.forEach([{ target: [FriendOf, [Entity, Position, Velocity]] }], (source, [friend, pos, vel]) => {
  // friend, pos, and vel all project from the same FriendOf target.
});
```

Every target projection is optional. If the source lacks `Rel`, every projected slot is
`undefined`. If the relationship exists, an `Entity` slot is the target while each component slot
is `undefined` when that target lacks the component.

Use `{ targets: [Rel, projection] }` to project every target. Unlike singular injection, the whole
term occupies **one callback tuple slot** containing a readonly array of rows. Each target produces
one row; row ordering follows the current target snapshot but is not a public ordering contract. The
row contains one value for a scalar projection or several values for a tuple projection:

```ts
.forEach(
  [{ targets: [FriendOf, [Entity, Position, Velocity]] }],
  (source, [friends]) => {
    // friends: ReadonlyArray<readonly [Entity, Position | undefined, Velocity | undefined]>
    for (const [friend, position, velocity] of friends) { ... }
  }
);
```

An absent relationship injects an empty array. The `Entity` value in each plural row is always
present; projected components remain optional. `target` and `targets` resolve live for `each`,
`forEach`, `update`, and `orderBy`. For deferred system `enter` and `exit` callbacks, vecs captures
their projected component and entity references plus sources when the event is routed. Inbox replay
retains those references even if storage or edges change; component objects are not cloned.

Inline projection tuples infer precise slot types. When reusing a projection tuple stored in a
variable, declare it `as const` to preserve each position's type.

`{ down: [Rel, [C1]] }` fans out: the callback fires once per source targeting the visited entity
through `Rel`, with that child's components filling the slots (nullable). `down` is allowed only
in `each` and `forEach`, at most once per tuple, and entities with zero children produce no calls.
`down` iterates **all** children through the relationship, independent of any membership filter:

```ts
.with(Body)
.each([Body, { down: [ChildOf, [Position]] }], (parent, [body, childPos]) => {
  // One call per ChildOf child; childPos is undefined when that child lacks Position.
});
```

### The `Iter` cursor

Pass `{ cursor: Iter, ... }` to `each`, `forEach`, `enter`, `exit`, `update`, or `orderBy` to receive
a reusable cursor instead of the bare entity:

```ts
import { Iter } from "@vworlds/vecs";

system.each(
  { cursor: Iter, inject: [Body, { target: [ChildOf, [Position]] }] },
  (it, [body, pos]) => {
    it.entity; // the visited entity
    it.src[0]; // entity body was read from (the visited entity)
    it.src[1]; // entity pos was read from (the ChildOf target), or undefined
  }
);
```

`it.src` holds the source per tuple slot: the visited entity for direct components, the first
target for every flattened `target` slot, the readonly target-array snapshot for the single
`targets` slot, and the specific child for `down` slots. Event-time `enter` / `exit` snapshots also
capture `Iter.src`. When `Iter` is not requested, the non-cursor path has no cursor allocation;
dispatch happens once at setup time. `each`/`forEach`/`update`/`orderBy` reuse cursor and
tuple instances across the pass, so snapshot what you need before triggering further mutations
from inside a callback. Passing `{ cursor: Entity, ... }` is also accepted and means the default
entity-first signature.

## Ordering and tracking

### `.orderBy(components, compare)` / `.orderBy(options, compare)`

Keep matched entities in a custom order. Iteration, `forEach`, and `each` then walk entities in
sorted order. Implies tracking:

```ts
world
  .system("Render")
  .with(Position, Sprite)
  .orderBy([Position], (_ea, [a], _eb, [b]) => a.y - b.y)
  .each([Position, Sprite], (e, [pos, sprite]) => sprite.draw(pos.x, pos.y));

world
  .system("Render")
  .with(Position, Sprite)
  .orderBy({ inject: [Position] }, (_ea, [a], _eb, [b]) => a.y - b.y)
  .each({ inject: [Position, Sprite] }, (e, [pos, sprite]) => sprite.draw(pos.x, pos.y));
```

Ties break by entity id, so the order is deterministic.

The order is maintained reactively. When data for a component in the injection tuple changes via
`set` or `modified`, the system refreshes the sort before the next ordered read. Keep comparators
dependent only on those injected components; unrelated component data is not watched for ordering.

### `.track()`

Enable membership tracking without an `each`: exposes `count`, `has(e)`, iteration, and `forEach`.
`each` and `orderBy` imply it. Tracked systems backfill already-matching entities when built.

## Cadence: `interval`, `rate`, and tick sources

By default a system fires on every frame of its phase. Three builders change that
(`lib/vecs/src/timer.ts`):

```ts
world.system("AI").interval(0.5).run(tickAI); // at most every 0.5 s (seconds!)
world.system("Send").rate(2).run(flush); // every 2nd tick of the current source
world.system("Log").tickSource(clock).run(log); // driven by a shared ITickSource
```

- `.interval(seconds)` replaces the cadence with an `IntervalTickSource`. Note the unit: seconds,
  unlike the millisecond deltas of `progress`. Interval boundaries tolerate floating-point
  residue so whole-frame intervals do not fire one frame late (see `IntervalTickSource`'s
  TSDoc for the tolerance). Each source fires at most once per frame, even with a large delta;
  positive residual time is preserved, and a tolerated negative remainder is clamped to zero.
- `.rate(n)` divides the current cadence source by `n` (for an unconfigured system: every `n`
  frames). `.rate(n, source)` divides an explicit upstream source.
- `.tickSource(source)` mirrors another source directly — an `IntervalTickSource`,
  `RateTickSource`, or **another system** (systems implement `ITickSource`).

When a cadence source is active, the `delta` passed to `run` is the accumulated milliseconds since
this system last fired. Standalone sources support `stop()`/`start()`. Chains compose:

```ts
const second = new IntervalTickSource(1);
const minute = new RateTickSource(60, second);

world.system("Hourly").tickSource(minute).rate(60).run((now, delta) => { ... });
```

Disabling a system suppresses its callbacks, but a disabled system used as a tick source still
drives downstream consumers — stop the clock itself if you need silence.

## `disable` / `enable` / `destroy`

```ts
const ai = world.system("AI").with(Enemy).run(tickAI);
ai.disable(); // pause: inbox cleared, new events dropped, run/each silent
ai.enable(); // resume; events from the disabled period are NOT replayed
ai.destroy(); // permanent: disables, then unregisters the backing entity
```

While disabled, query membership is still maintained, so the tracked set is correct on resume.
`destroy` fires no `exit` callbacks. Both `disable` and `enable` are idempotent and chainable.

## Introspection

Read `world.pipeline` after finishing system configuration to inspect the **existing flat execution
pipeline**, not a separately maintained inventory. It returns `readonly System[]`, including disabled
systems, in the order selected by the pipeline query (including a custom `setPipeline`). Between
frames it builds pending queries and refreshes only when the pipeline query changed. It does not
execute systems or drain deferred commands. During a frame it returns that frame's pipeline; queued
changes become visible after their normal flush. Re-read the getter after changes: an old array is
not a live subscription. Read-only means the TypeScript array API; do not cast away the type to mutate it.

```ts
import {
  AlwaysTickSource,
  DependsOn,
  IntervalTickSource,
  RateTickSource,
  System,
  World,
  type ITickSource,
} from "@vworlds/vecs";

function describeCadence(source: ITickSource): string {
  if (source instanceof AlwaysTickSource) return "every tick";
  if (source instanceof IntervalTickSource) return `every ${source.seconds}s`;
  if (source instanceof RateTickSource) {
    return `every ${source.rate} ticks of ${
      source.source ? describeCadence(source.source) : "world frames"
    }`;
  }
  if (source instanceof System) return `system ${source.name}`;
  return "custom clock";
}

const world = new World();
world
  .system("AI")
  .interval(0.5)
  .run(() => {});
for (const [order, system] of world.pipeline.entries()) {
  console.log({
    order,
    name: system.name,
    phase: system.entity.target(DependsOn)?.name,
    cadence: describeCadence(system.cadence),
    enabled: system.enabled,
  });
}
```

`system.cadence` exposes the current source; the existing `.tickSource(source)` method configures
it. Ask `system.hasDefaultCadence` for the default every-tick case.
Each world owns its own every-frame clock, so stepping one world inside a system of another never
leaks deltas between them. The module constant `ALWAYS_TICK_SOURCE` is deprecated and will be
removed next release; `tickSource()` and `rate()` still accept it and resolve it to the system's
world clock. During this release `system.cadence` still returns the constant for a system on its
world's default clock; next release it returns `world.alwaysTickSource`. Use
`system.hasDefaultCadence` instead of an identity comparison so your code works on both sides.
`IntervalTickSource.seconds`, `RateTickSource.rate`, and `RateTickSource.source` are getters;
an unconfigured standalone rate source has no upstream source and counts world frames. Replacing
cadence changes the getter immediately. A source's existing `start`/`stop` controls still work.

Use `system.callbacks` to distinguish per-tick work from reactive callbacks, and `system.watched`
to inspect the component classes whose changes trigger `update`. Both are frozen snapshots and
reflect builder registrations immediately, including before the system is built:

```ts
const perTickSystems = world.pipeline.filter(
  (system) =>
    system.hasDefaultCadence &&
    (system.callbacks.includes("each") || system.callbacks.includes("run"))
);
const watchedComponents = world.pipeline.flatMap((system) => system.watched);
```

`callbacks` lists registered kinds (`each`, `run`, `enter`, `update`, `exit`); `watched` contains
only components with an `update` callback, not every component in the query predicate.

Name and phase need no new API: `system.name` and `system.entity.target(DependsOn)` already expose
them. Systems are entities carrying `System`, so a query with `System` can inventory them independently
of pipeline membership; retrieve the instance with `entity.get(System)`. The existing `toString()`
display is unchanged; introspection does not add structured query terms or `world.systems()`.

## Reference

| Method                                                           | Description                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `with(...specs)` / `without(dsl)`                                | Declare membership; see [the DSL](./queries-and-filters.md#the-query-dsl).                                                       |
| `phase(anchor)`                                                  | Place after a phase anchor (name or entity). Default `ON_UPDATE`.                                                                |
| `enter(cb)` / `enter(inject, cb)`                                | Fires once when an entity starts matching.                                                                                       |
| `update(C, cb)` / `update(options, cb)`                          | Fires on `set`/`modified` of `C` on a member; `options.onEnter: true` also fires on entry for present watched components.        |
| `exit(cb)` / `exit(inject, cb)`                                  | Fires when an entity stops matching; injection retains references captured at exit time.                                         |
| `each([C...], cb)`                                               | Fires per tracked entity every tick. Implies `track`. One per system.                                                            |
| `run(cb)`                                                        | Fires once per tick, `(now, delta)`.                                                                                             |
| `interval(seconds)` / `rate(n[, source])` / `tickSource(source)` | Cadence control.                                                                                                                 |
| `orderBy([C...], compare)`                                       | Sorted membership refreshed when injected comparator data changes. Implies `track`.                                              |
| `track()`                                                        | Expose `count`, `has`, iteration, `forEach` without `each`.                                                                      |
| `ignoreSource(query \| dsl)`                                     | Drop `update` events originating from matching systems; see [Queries](./queries-and-filters.md#silencing-feedback-ignoresource). |
| `disable()` / `enable()`                                         | Pause / resume processing. Idempotent.                                                                                           |
| `destroy()`                                                      | Permanently remove the system (no `exit` callbacks).                                                                             |
| `didTick` / `lastFireDelta`                                      | This frame's cadence result; ms accumulated into the last fire.                                                                  |
| `cadence` / `enabled`                                            | Read current cadence source and enabled state; see [Introspection](#introspection).                                              |
| `callbacks` / `watched`                                          | Read registered callback kinds and update-watched component classes; see [Introspection](#introspection).                        |
| `world.pipeline`                                                 | Read systems in pipeline execution order; see [Introspection](#introspection).                                                   |
| `count` / `has(e)` / `belongs(e)` / iteration / `forEach`        | Shared query surface; see [Queries](./queries-and-filters.md#reading-a-query).                                                   |

`groupBy` is not available on systems — use `world.query(...).groupBy(...)`.
