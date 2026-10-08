# Execution Model

How `world.progress` runs your systems: the phase spine, ordering guarantees, deferred mutation,
and reactive event routing. Every design trick in vecs follows from the rules on this page.

## One tick, anatomically

`world.progress(now, delta)` (`lib/vecs/src/world/world.pipeline.ts`) does, in order:

1. **`beginFrame(delta)`** — flush any pending top-level commands, rebuild the flat pipeline if
   the pipeline query changed (this is when newly created systems are inserted), and evaluate
   every registered tick source once (see [Systems — cadence](./systems.md#cadence-interval-rate-and-tick-sources)).
2. **For each system in pipeline order:** run the system, then `flush()` the world's command
   queue.
3. **`endFrame()`** — close the frame.

`now` and `delta` are both milliseconds. You can also call `beginFrame` / `endFrame` yourself and
run systems manually, but `progress` is the normal driver.

## Phases: the pipeline spine

Systems are grouped by **phase**, and phases run in a fixed order. The eight built-in phases are
plain entities, created by `PipelineModule` and chained with the `DependsOn` relationship
(`lib/vecs/src/modules/pipeline.ts`). The exported constants are their entity names:

| Constant      | Entity name        | Use it for                                                                          |
| ------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `ON_LOAD`     | `vecs::OnLoad`     | Load data _into_ the ECS: inputs, network snapshots, external reads.                |
| `POST_LOAD`   | `vecs::PostLoad`   | Process raw loaded data: turn key presses into high-level actions.                  |
| `PRE_UPDATE`  | `vecs::PreUpdate`  | Final prep before game logic: clean up last frame, prepare state gameplay will use. |
| `ON_UPDATE`   | `vecs::OnUpdate`   | **The default phase.** Main gameplay/simulation logic.                              |
| `ON_VALIDATE` | `vecs::OnValidate` | Validate state after updates: collision detection, constraint checks.               |
| `POST_UPDATE` | `vecs::PostUpdate` | Apply corrections from validation: resolve collisions, fix up state.                |
| `PRE_STORE`   | `vecs::PreStore`   | Prepare data for output: compute render state once all logic is done.               |
| `ON_STORE`    | `vecs::OnStore`    | Store/emit the final frame: rendering, writing output, sending snapshots.           |

`BUILTIN_PIPELINE_PHASES` exports the eight names in order. Map your work onto this taxonomy
rather than inventing phases: input belongs in `ON_LOAD`/`POST_LOAD`, gameplay in `ON_UPDATE`,
validation and correction in `ON_VALIDATE`/`POST_UPDATE`, output in `PRE_STORE`/`ON_STORE`.

### Assigning a system to a phase

Every system defaults to `ON_UPDATE`. Call `.phase(...)` only to run elsewhere:

```ts
import { ON_STORE } from "@vworlds/vecs";

world.system("Render").phase(ON_STORE).with(Sprite, Position).each([Sprite, Position], draw);
```

`.phase(anchor)` accepts a phase name or an entity. It sets `DependsOn` on the system's backing
entity (atomically replacing its previous exclusive edge) and tags the anchor with `Phase`,
creating the anchor entity if the name is new. **A system lives in exactly one phase.** If a concern
needs work in two phases, split it into two systems.

### Ordering guarantees

1. **Across phases, order is guaranteed by the phase spine.** A system in `PRE_STORE` always runs
   before any system in `ON_STORE`, regardless of when either was created.
2. **Within a phase, systems run in creation order** (entity-id order — the order `world.system`
   was called). An umbrella module controls this by the order it loads sub-modules.
3. **Never rely on registration order for cross-module correctness.** When two independent
   features must order against each other, express it with phases.

### The pipeline is a query

The pipeline itself is an ordered query over system entities. The default, installed by
`PipelineModule`:

```ts
world.setPipeline({
  with: { all: [System, { target: [DependsOn, Phase] }] },
  cascade: DependsOn,
});
```

It matches every `System` whose backing entity `DependsOn` a `Phase`, ordered depth-first along
the `DependsOn` cascade. `world.setPipeline(spec)` replaces it; the world always appends `System`
to the spec so the result flattens to systems.

### Custom phases: `insertPhaseAfter`

`insertPhaseAfter(phase, anchor)` splices an existing `Phase` entity into the spine directly after
`anchor`, replacing the anchor's downstream `DependsOn` edges with edges to the new one:

```ts
import { insertPhaseAfter, ON_UPDATE, Phase } from "@vworlds/vecs";

const physicsStep = world.entity("physics-step").add(Phase);
insertPhaseAfter(physicsStep, world.entity(ON_UPDATE));
```

Reserve custom phases for engine-level modules that genuinely need their own spine (the physics
engine inserts its step phases after `ON_UPDATE`). Application and render systems should use the
built-in taxonomy.

## Deferred mutation and flush boundaries

Inside a system body, a `Query.forEach` / `Filter.forEach` iteration, or any `world.defer(...)`
block, the world is in **deferred mode**: entity mutations (`add` / `attach` / `set` / `ensure` /
`remove` / `destroy` / `modified`, explicit relationship edge additions/removals, and
`world.entity()` creation) are queued as commands instead of applied inline. The queue drains when
the scope that opened deferral ends.

All commands share one FIFO queue, including relationship edge commands and commands enqueued by
hooks while that queue is draining. Their final state is therefore determined by call order. For
example, deferred `add(R, a)`, `add(R, b)`, `remove(R, a)` leaves only `b`; on an `Exclusive`
relationship each queued addition atomically replaces the edge present when that command executes.

For the pipeline this means: **a structural change made by system A is applied in the flush
immediately after A finishes, so it is visible to every later system in the same tick** — later in
the same phase or in a later phase — but not to A itself mid-iteration. This single fact enables
teardown-before-create ordering, the companion-component lifecycle, and same-tick reconciliation
(see the [Design guide](./design-guide.md)).

### What reads see while deferred

While a mutation is queued but not yet applied, reads return the pre-mutation state:

| After calling…            | `entity.get(C)` / `entity.getMut(C)` returns…              |
| ------------------------- | ---------------------------------------------------------- |
| `entity.add(C)`           | `undefined` — no instance has been created yet.            |
| `entity.attach(instance)` | `undefined`, if `C` was absent before.                     |
| `entity.set(C, props)`    | The **previous** value (or `undefined` if `C` was absent). |
| `entity.ensure(C)`        | A mutable component, even when newly created.              |
| `entity.remove(C)`        | Still the component instance.                              |

Relationship reads follow the same committed-state rule. After queued `add(R, target)` or
`remove(R, target)`, `has(R)`, `target(R)`, `targets(R)`, `hasTarget(R, target)`, and reverse
`children(R)` continue to report the state from before the deferred scope until the FIFO queue
applies those edge commands.

Outside any deferred scope (top-level user code), the same calls execute inline and effects are
visible immediately.

### Controlling deferral yourself

```ts
world.deferred;            // true while the world is in deferred mode
world.defer(() => { ... }); // run a block in deferred mode, drain on exit
world.beginDefer();         // open a scope manually…
world.endDefer();           // …close it (drains at the outermost scope)
world.flush();              // drain queued top-level commands now
```

Scopes nest: a `Filter.forEach` inside a system inherits the system's scope and does not drain on
exit. `flush()` is a no-op while any scope is open; it also builds queries created since the last
flush.

## Reactive routing

When the world applies a command, it routes events to everything that watches the affected
component:

- **Hooks** (`onAdd` / `onSet` / `onRemove`) fire synchronously at the moment the command is
  applied — inline outside deferred mode, or during the drain.
- **Relationship edge hooks** (`onTargetAdd` / `onTargetRemove`) fire synchronously after each
  edge and reverse-index change. Edge changes do not fire `onSet`.
- **Standalone `Query` callbacks** (`enter` / `update` / `exit`) also fire synchronously during
  routing.
- **Systems** queue events into an ordered **inbox** instead, and replay the inbox at the top of
  their next run (`lib/vecs/src/system.ts`). So systems react to change without scanning, and they
  react _in their own phase slot_, in event arrival order.

Four routing rules worth memorizing:

- **`update(C)` is change-only unless you opt into entry.** When an entity enters a system,
  `{ onEnter: true }` update watchers push an `update` event for already-present watched components.
  Use that for initialization; leave it off when a separate `enter` owns setup.
- **`enter` and `exit` injection read snapshots.** Direct components, singular/plural target
  projections, and `Iter.src` are captured when the event is routed, so inbox replay retains those
  component and entity references even if storage or edges change before the system runs. Component
  objects are not deep-cloned.
- **`enter` is drain-time truthful.** A system only receives `enter` when the entity is still a
  member when that system runs. If it left before the inbox drains, vecs drops both that queued
  `enter` and its paired `exit`; an entity that re-enters before draining is a member again, so the
  queued events replay in order as `enter`, `exit`, `enter`. The details are in
  [Systems — `.enter`](./systems.md#entercallback--enterinject-callback--enteroptions-callback).
- **In-place mutation needs `modified`.** Assigning to component fields directly notifies no one.
  Call `entity.modified(C)` (or use `set` / `getMut` / `ensure`) to route the change.

## Why the patterns work

Putting the rules together:

- _Teardown before create:_ an `exit`-driven teardown system in `PRE_STORE` runs before an
  `enter`-driven creation system in `ON_STORE`; the teardown's `remove` is flushed between them,
  so a type swap tears down the old companion and builds the new one in the same tick.
- _React, don't scan:_ `update(C)` touches nothing on idle entities, where `each` would visit all
  of them every tick.
- _Same-tick reconciliation:_ a system that writes a component early in the tick is guaranteed
  that later phases see the new value.

The [Design guide](./design-guide.md) develops each of these into a full pattern.
