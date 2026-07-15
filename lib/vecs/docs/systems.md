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
after that throw.

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
.with({ target: [FriendOf, Position] })                   // relationship target has Position
.with({ parent: Body })                                   // ChildOf target has Body
```

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

### `.exit(callback)` / `.exit(inject, callback)` / `.exit(options, callback)`

Fires when an entity stops matching (component removed, or entity destroyed). Directly injected
components are read from a **snapshot captured at exit time**, so they are still resolvable even
though they are being removed; `target` projections resolve live at callback time and may be
`undefined`:

```ts
.exit([Sprite], (e, [sprite]) => sprite.destroy());
.exit({ inject: [Sprite] }, (e, [sprite]) => sprite.destroy());
```

## Per-tick callbacks: `each` and `run`

### `.each(components, callback)` / `.each(options, callback)`

Fires every tick the system runs, once per tracked entity, regardless of change. Use it only for
genuinely per-frame sweeps — when reacting to change suffices, prefer `update` (see
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

Nullability follows membership: components guaranteed by `with` (or `hint`) are non-nullable;
anything else resolves as `T | undefined` — guard it. (`enter`/`exit` injection requires the
direct components to be present and throws otherwise; list only components your predicate
guarantees.)

### Relationship injection: `target` and `down`

`{ target: [Rel, projection] }` follows the entity's relationship to its target and flattens the
projection into the callback tuple. Use a component class to inject one target-side component, use
`Entity` to inject the target itself, or use a tuple to inject several values in order:

```ts
.enter([{ target: [FriendOf, Entity] }], (source, [friend]) => {
  // friend is source.target(FriendOf), or undefined.
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
is `undefined` when that target lacks the component. Target projections resolve live rather than
from the direct-component snapshot used by `enter` and `exit`.

Inline projection tuples infer precise slot types. When reusing a projection tuple stored in a
variable, declare it `as const` to preserve each position's type.

`{ down: [Rel, [C1]] }` fans out: the callback fires once per child targeting the visited entity
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

`it.src` holds the source entity per tuple slot: the visited entity for direct components, the
relationship target for `target` slots, the specific child for `down` slots. When `Iter` is not
requested, the non-cursor path runs with zero per-entity overhead — dispatch happens once at setup
time. `each`/`forEach`/`update`/`orderBy` reuse cursor and tuple instances across the pass, so
snapshot what you need before triggering further mutations from inside a callback. Passing
`{ cursor: Entity, ... }` is also accepted and means the default entity-first signature.

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
  unlike the millisecond deltas of `progress`.
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

## Reference

| Method                                                           | Description                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `with(...specs)` / `without(dsl)`                                | Declare membership; see [the DSL](./queries-and-filters.md#the-query-dsl).                                                       |
| `phase(anchor)`                                                  | Place after a phase anchor (name or entity). Default `ON_UPDATE`.                                                                |
| `enter(cb)` / `enter(inject, cb)`                                | Fires once when an entity starts matching.                                                                                       |
| `update(C, cb)` / `update(options, cb)`                          | Fires on `set`/`modified` of `C` on a member; `options.onEnter: true` also fires on entry for present watched components.        |
| `exit(cb)` / `exit(inject, cb)`                                  | Fires when an entity stops matching; direct injection reads an exit-time snapshot.                                               |
| `each([C...], cb)`                                               | Fires per tracked entity every tick. Implies `track`. One per system.                                                            |
| `run(cb)`                                                        | Fires once per tick, `(now, delta)`.                                                                                             |
| `interval(seconds)` / `rate(n[, source])` / `tickSource(source)` | Cadence control.                                                                                                                 |
| `orderBy([C...], compare)`                                       | Sorted membership refreshed when injected comparator data changes. Implies `track`.                                              |
| `track()`                                                        | Expose `count`, `has`, iteration, `forEach` without `each`.                                                                      |
| `ignoreSource(query \| dsl)`                                     | Drop `update` events originating from matching systems; see [Queries](./queries-and-filters.md#silencing-feedback-ignoresource). |
| `disable()` / `enable()`                                         | Pause / resume processing. Idempotent.                                                                                           |
| `destroy()`                                                      | Permanently remove the system (no `exit` callbacks).                                                                             |
| `didTick` / `lastFireDelta`                                      | This frame's cadence result; ms accumulated into the last fire.                                                                  |
| `count` / `has(e)` / `belongs(e)` / iteration / `forEach`        | Shared query surface; see [Queries](./queries-and-filters.md#reading-a-query).                                                   |

`groupBy` is not available on systems — use `world.query(...).groupBy(...)`.
