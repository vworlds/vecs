# vecs Design Guide

How to design with **vecs** — for humans and agents. This is a practical, opinionated
guide distilled from real designs (the physics engine, the Phaser render layer, the demo).
It explains the model, the execution semantics that make the tricks work, the idioms to
reach for, and the anti-patterns to avoid.

This guide assumes you know the machinery; the [docs home](./README.md) holds the
subsystem guides — start with [Concepts](./concepts.md) and the
[Execution model](./execution-model.md) if you are new.

> **Golden rule:** components are _data_, systems are _behavior_, and **lifecycle is driven
> by the presence and change of components — not by imperative bookkeeping.** Almost every
> good pattern below is a consequence of taking that seriously.

> **How to use this guide.** You don't need to read all of it every time. Skim §1–§2 (the model
> and the execution facts everything else follows from) and the §8 anti-patterns + §9 pitfalls
> tables — together a fast TL;DR — then deep-read only the section your task touches: §3
> Components, §4 Systems & queries, §5 Phases, §6 Modules, §7 Patterns. The §10 case study shows
> all of it working together.

---

## 1. The model in one minute

| Concept       | What it is                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **World**     | The container. Holds entities, registered components, systems, phases, modules. You drive it with `world.progress(now, delta)`.                                   |
| **Entity**    | An id with a set of components. Create with `world.entity()`.                                                                                                     |
| **Component** | A plain data class. Registered with `world.component(C)` (or by a module). No behavior.                                                                           |
| **System**    | A query + reactive callbacks (`enter`/`update`/`exit`) or a `run`/`each` body. Created with `world.system(name)`.                                                 |
| **Phase**     | An ordered slot in the per-tick pipeline. Systems are assigned to a phase with `.phase(P)`.                                                                       |
| **Module**    | A unit of packaging: `class M extends Module<Config>` whose `init()` registers components, systems, phases, and policy. Installed with `world.module(M, config)`. |

---

## 2. The execution model (read this first — every trick follows from it)

`world.progress(now, delta)` runs the **pipeline**: systems grouped by **phase**, phases in a
fixed order. (The full mechanics are in [Execution model](./execution-model.md); this section
is the design-relevant core.) Internalize these four facts:

1. **Phases run in a fixed order.** The eight built-in phases (`lib/vecs/src/modules/pipeline.ts`):

   | Phase         | Use it for                                                                                             |
   | ------------- | ------------------------------------------------------------------------------------------------------ |
   | `ON_LOAD`     | Load data _into_ the ECS: inputs, network snapshots (`ClientWorld.apply()` runs here), external reads. |
   | `POST_LOAD`   | Process raw loaded data: turn key presses into high-level actions, map inputs to commands.             |
   | `PRE_UPDATE`  | Final prep before game logic: clean up last frame, prepare state gameplay will use.                    |
   | `ON_UPDATE`   | **The default phase.** Main gameplay/simulation logic goes here.                                       |
   | `ON_VALIDATE` | Validate state after updates: collision detection, constraint checks.                                  |
   | `POST_UPDATE` | Apply corrections from validation: resolve collisions, fix up state.                                   |
   | `PRE_STORE`   | Prepare data for output: compute transforms/render state once all logic is done, before storage.       |
   | `ON_STORE`    | Store/emit the final frame: rendering, writing output, sending snapshots.                              |

2. **Within a phase, systems run in registration order** (creation/eid order). So the order you
   _create_ systems (e.g. the order an umbrella module loads sub-modules) is the order they run
   _within the same phase_. Across **different** phases, ordering is guaranteed by the phase
   spine — independent of registration order.

3. **Structural changes are deferred and flushed after every system.** When a system calls
   `entity.set/add/remove`/`entity.destroy()` during its run, the change is queued and applied
   in a `flush()` **immediately after that system finishes**
   (`lib/vecs/src/world/world.pipeline.ts`: `system._run()` then `this.flush()`). Consequence:
   **a structural change made by system A is visible to every
   later system in the same tick** (later in the same phase, or in a later phase). It is _not_
   visible to A mid-iteration. This single fact enables the companion-component lifecycle, the
   teardown-before-create ordering, and same-tick reconciliation.

4. **Reactive routing.** `set`/`add`/`remove`/`destroy` route `enter`/`update`/`exit` events into
   the matching systems' inboxes; each system drains its inbox at the top of its run. So systems
   react to change without scanning.

---

## 3. Components

### Small and single-purpose, always optional

Prefer many small components over one big one. `Position {x,y}`, `Rotation {angle}`,
`LinearVelocity {x,y}` — **not** a `Transform {x,y,angle,sx,sy}` god-component. Why:

- **Queries compose.** `.with(Position, Rotation)` selects exactly what a system needs; a system
  that only reads position isn't coupled to rotation.
- **Optionality is the point.** An entity has a component or it doesn't. A render entity that
  never rotates simply omits `Rotation`; a sync system gated on `.with(Rotation, ...)` ignores it.
  Don't bake optional fields into a required mega-component with sentinel defaults.
- **Exclusivity and reuse.** Small components can be grouped, made exclusive, and reused across
  unrelated features.

A component is a **plain data class**. No methods, no behavior:

```ts
export class Position {
  x = 0;
  y = 0;
}
export class Rotation {
  angle = 0;
}
```

### Networked components

Mark wire fields with `@wireType` from `@vworlds/vecs-wire` (`import { wireType }`). The
**order** you pass components in `networkComponents` _is the wire protocol_ (wire type id = index + 1).
Reordering is a breaking protocol change — snapshot-test the order.

```ts
class Arc {
  @wireType("f32") radius = 0.5;
}
new ServerWorld({ networkComponents: [Position, Rotation, /* … */ Arc] });
```

> **Decorator gotcha.** `@wireType` must work under both _legacy_ (`experimentalDecorators`, used by
> `tsc`) and _standard_ TC39 decorators (what esbuild — `tsx`/Vite — emits for source files).
> If you load decorated component classes from **source** through an esbuild-based runtime and
> their fields silently fail to register, that's the standard-vs-legacy mismatch. vecs-wire
> supports both; if you author new decorators, preserve that.

### Resources as components (hold non-ECS objects)

To bind a non-ECS resource (a Phaser `GameObject`, a WASM handle, a DOM node) to an entity,
**store the live object itself as a component** with `entity.attach(obj)` instead of keeping a
side `Map<eid, resource>`. `attach` registers the instance under its own class, so the entity's
component set _is_ the lifecycle; queries drive create/destroy; reset is free.

```ts
const obj = scene.add.arc(0, 0); // a Phaser GameObject
entity.attach(obj); // the GameObject is now a component, keyed by its class

world.component(Phaser.GameObjects.Arc).on("remove", (_entity, obj) => obj.destroy());
```

`onRemove` (below) releases the resource whenever it leaves — whether removed explicitly,
because the entity was destroyed, or because the world was disposed (`world.dispose()` destroys
application entities and then infrastructure and singleton data; see
[Disposing a world](./entities.md#disposing-a-world)).
When several resource types should share one cleanup hook or be queried together, give them a
common **interface** with `Implements` (see §7 and the §10 case study). A plain wrapper component
(`class Handle { obj }`) is still fine when you need extra fields beside the resource.

### Component lifecycle hooks: `onAdd` / `onSet` / `onRemove`

`world.component(C)` returns a handle with hooks fired on every entity:

```ts
world.component(Impulse).on("set", (entity, impulse) => {
  /* accumulate */
});
world.component(Phaser.GameObjects.Arc).on("remove", (_entity, obj) => obj.destroy());
```

Use them for resource management and cross-cutting reactions that aren't worth a system. (Note
the difference from systems: hooks are per-component-instance and run at the mutation site;
systems are queries that run in a phase.) Multiple handlers may be registered per event; they fire
in registration order and are removed with `off(event, handler)` by reference (see
[Components — hooks](./components.md#hooks-component-and-relationship-edges)).

### Component traits: policy on component entities

For schema reflection, query the built-in `ComponentDef` marker with
`world.query("Definitions").with(ComponentDef).build()` rather than scanning all entities with
`instanceof Component`. See [Reflecting on component definitions](./components.md#reflecting-on-component-definitions)
for membership and local-only snapshot/network behavior.

A registered component is also an entity. Components attached to that component entity can declare
policy for every use of the component type; these configuration components are **component traits**:

```ts
world.component(Gravity).add(Singleton);
world.component(Inventory).add(Exclusive).add(OwnedTarget);
world.component(ChildOf).add(Exclusive).add(Traversable);
world.component(Orange).set(Implements, { interfaces: [Fruit] });
```

Declare custom policy components explicitly with `Trait`; storing ordinary data on a definition
does not make it a trait:

```ts
class Audited {}
world.component(Audited).add(Trait);
world.component(Position).add(Audited);
const traits = world.query("Traits").with(ComponentDef, Trait).build();
```

The query tracks declarations incrementally. `Trait` is local-only metadata, not an enforcement
gate or a hook installer; see [trait reflection](./components.md#reflecting-on-component-definitions).

| Trait/declaration | Reach for it when                                                                  |
| ----------------- | ---------------------------------------------------------------------------------- |
| `Singleton`       | At most one entity may carry the component                                         |
| `Implements`      | Concrete components should be queryable through abstract aliases                   |
| `Exclusive`       | A relationship must have at most one target                                        |
| `Traversable`     | An exclusive relationship hierarchy needs depth or cascade ordering                |
| `OwnedTarget`     | An exclusive relationship owns its explicitly added target                         |
| `OneOf`           | A relationship's targets must be direct children of a declared parent (enum-style) |
| `With`            | Adding one component should bring another along, as a companion it does not own    |
| `Requires`        | Adding one component should bring another, and removing it should take it away     |
| `OnSnapshot`      | Choose a component's subtree snapshot policy                                       |

Traits declare policy; modules implement it through hooks and metadata. Configure them in module
setup, not inside systems. Lifecycle differs by trait: `OwnedTarget` and `Singleton` are setup-time
policy, `Traversable` backfills, and `Implements` recomputes declarations. Do not assume traits are
dynamically removable. See the [Components guide](./components.md#component-traits-policy-on-component-entities)
for the full model and custom-trait guidance.

`With` is a pair-form trait: `world.component(Motion).add(With, world.component(Position))` adds a
`Position` whenever a `Motion` is added. It only brings the companion along: removing `Motion` does
not remove `Position`, and a `Position` the entity already holds is left as it is. A networked
client has one more rule, because the server decides what a client replicates but the client decides
what it derives. **`ClientWorld.apply` skips a network removal of a component that another
component present on the entity brings through `With` or `Requires`**, so a server can swap the
source of a client-local component in one diff, say a streamed `Position` for a dead-reckoned
`Motion`, and the entity never goes without it: no `remove` hook fires, and the queries and `DrawBy`
children that match on it never see it leave. The rule is judged once the diff has applied, so a
bringer that the same diff sets counts as present and one it removes does not. The entity-destroy
path is unaffected, and a relationship is removed as sent (see
[Applying a frame](../../vecs-client/docs/client-world.md#applying-a-frame)).

`Requires` is the owning counterpart, declared the same way:
`world.component(DeadReckoned).add(Requires, world.component(Motion))` adds `Motion` with the tag,
and removing the tag removes `Motion` unless another component on the entity still brings it. Pick
it per pair: dead reckoning owns `Motion` and its prediction through `Requires`, but only brings the
physics `Rotation` through `With`, because the body needs it either way. Do not hand-write a
`remove` hook that removes companions; a hook stays only for state `Requires` cannot express, such
as a component the module adds on demand. See
[Component traits](./components.md#component-traits-policy-on-component-entities) for the full
rules.

### Exclusive component groups

`world.setExclusiveComponents(A, B, C)` declares a mutually exclusive set: setting one
**auto-removes** the others. This is how you model "exactly one of N" (one renderable per
entity; one physics shape per body) and it makes **type changes** clean — see the swap pattern
in §7.

```ts
world.setExclusiveComponents(...phaserRenderableComponents); // Arc | Rectangle | Text | …
entity.set(Arc, { radius: 1 });
entity.set(Rectangle, { width: 2, height: 1 }); // Arc auto-removed
```

### Relationships

A relationship is a component that stores edges from its source entity to one or more target
entities. Add and remove those edges explicitly:

```ts
class InCell extends Relationship {}
entity.add(InCell, cell);
entity.add(InCell, neighboringCell);
entity.remove(InCell, cell);

entity.target(InCell); // one current target, or undefined
entity.targets(InCell); // readonly snapshot of every target
entity.hasTarget(InCell, neighboringCell); // true
world.query("ByCell").with(Networked, Position).groupBy(InCell); // index by target
```

Relationships are multi-target by default. Add the `Exclusive` relationship trait when a source may
have at most one target; adding a different edge then replaces the old edge. This cardinality trait
is separate from `world.setExclusiveComponents(...)`, which prevents different component types from
coexisting on one entity.

For a zero-or-one aggregate whose lifetime remains bound to its source, create the target explicitly
and configure the relationship with both `Exclusive` and `OwnedTarget` during setup:

```ts
world.component(Inventory).add(Exclusive).add(OwnedTarget);
const inventory = world.entity();
player.add(Inventory, inventory); // inventory becomes ChildOf player
```

`OwnedTarget` requires `Exclusive`, never creates a target implicitly, destroys the displaced target
when a new edge replaces it, and destroys the current target when its edge or relationship is
removed. `Traversable` also requires `Exclusive` because hierarchy depth needs one parent. Edge
hooks, `onTargetAdd` and `onTargetRemove`, observe each explicit edge transition and compose with
these policies.

- **Target storage is private.** Read edges with `target` / `targets` / `hasTarget`; mutate them only
  with `add(Rel, target)` and `remove(Rel, target)` (or `remove(Rel)` for all edges). There is no
  public `Relationship.target` field.
- **Relationships can be networked** when listed in `networkComponents`. A relationship snapshot
  carries all target eids plus the relationship's ordinary wire fields. The client reconciles the
  complete edge set and creates ghost targets that have not arrived yet. Use a dedicated
  relationship class per concern so ownership, hierarchy, and display links do not overload one
  relationship.
- **Edge changes do not change the source archetype** while at least one edge remains. Prefer
  replacing an exclusive edge, or adding/removing multi-target edges, over swapping marker
  components to express membership.

---

## 4. Systems & queries

```ts
world
  .system("name")
  .with(/* membership spec */)
  .without(/* exclusion spec */)
  .phase(ON_UPDATE)
  .enter(/* … */)
  .update(C /* … */)
  .exit(/* … */);
```

### Membership: `.with` / `.without`

`.with(...)` defines who's in the query; `.without(...)` excludes. Specs can be component
classes or DSL objects (`{ all: [...] }`, `{ any: [...] }`, `{ parent: X }`, `{ target: [Rel, Tag] }`).

> `.with(...)`, `.without(...)`, and `.update(C)` own membership. `.update(C)` watches change events
> and also requires `C`, so `.with(A).update(C)` matches entities carrying both `A` and `C`.

**`.without` is not free.** `.without(X)` is `.with({ not: X })`: a `not` term holds every live
entity that lacks `X`, a world-sized set, and the query intersects it with its positive terms. The
exclusion does not run over the positive terms' candidates. Vecs seeds that set with one scan of
the world when the term is first built, then adds each new entity to it, removes each destroyed
entity from it, and flips an entity in or out when `X` is added to it or removed from it. Changes
to `X`'s data cost nothing. The term is shared by every query that excludes the same `X`, so the
upkeep is paid once per distinct exclusion, plus one membership check per query that uses it.

- Add `.without(X)` only when the exclusion is needed, and put positive terms next to it: they keep
  the query's members and callbacks small. A query made only of `.without` terms tracks every
  entity in the world.
- The creation pattern `.with(NewShape).without(Phaser.GameObjects.NewKind).enter(...)` relies on
  that narrowing. The positive term limits the members to the few entities that just got
  `NewShape`, while the exclusion keeps those that already have a display object from entering.

Details: [Queries and filters](./queries-and-filters.md#the-cost-of-not-and-without).

### Reactive callbacks: `enter` / `update` / `exit`

- **`enter`** — fires once when an entity _becomes_ a member. Use it for one-time setup
  (create the resource). It fires only when the entity remains a member when the system drains;
  vecs drops a transient entry and its paired exit, so setup code does not need a `destroyed` guard.
- **`update(C, …)`** — adds `C` to the predicate and fires when watched component `C` is modified.
  Pass `{ onEnter: true }` when it should also fire on entry for an already-present watched
  component. Use that to initialize on entry _and_ react to changes; leave it off when a separate
  `.enter` owns initialization.
- **`exit`** — fires when an entity stops matching (a component removed, or the entity destroyed).
  Its injected components are read from a **snapshot captured at exit time**, so they're still
  resolvable even though they're being removed. `entity.destroyed` tells you why it exited: `true`
  means it died; `false` means it only left the query. Use `if (entity.destroyed) return;` for teardown
  only for entities that stay alive, not to protect writes: every write to a dying entity is dropped.

**Repeated writes in one tick.** Vecs never merges `update` events, so a callback fires once per
routed write. `entity.modified(C)` and `entity.getMut(C)` coalesce through the entity's dirty bit:
repeated calls before the queued command drains give one `update`. Each `entity.set(C, …)` queues
its own command and routes its own `update`, so three `set` calls give three callbacks. Write in
place plus `modified` (or `getMut`) to get one callback per tick, or compare before `set`. When
producers already use `modified`/`getMut`, do not add a defensive per-tick dedupe or batching layer
on the consumer side. See [Systems](./systems.md#repeated-writes-in-one-tick).

Choose `onEnter: true` by asking who owns the initial value:

- Use **`onEnter: true`** for projection / sync callbacks: copying ECS data into a runtime object,
  another component space, a network snapshot, a physics body, or an index/cache. If an entity
  enters with `Position { x: 1, y: 2 }`, a renderer should not stay at its default `(0, 0)` until
  the next position write.
- Use **plain `update(C, cb)`** for mutation-only callbacks that should react only after the entity
  is already live: expensive rebuilds, destructive recreate paths, validation/repair passes, or
  post-construction setters where an `enter` callback already consumed the same component state.
- Do not duplicate an `.enter(...)` body and an `.update({ onEnter: true })` body that perform the
  same work. Pick one owner: explicit `.enter` for separate lifecycle setup, or one
  `{ onEnter: true }` update callback for "initialize from current value, then keep synced."

```ts
// ❌ redundant when update already owns initialization (Transform = Implements marker → the attached GameObject)
.enter([Rotation, Transform], (_e, [r, obj]) => obj.setRotation(coords.rot(r.angle)))
.update({ watch: Rotation, onEnter: true, inject: [Transform] }, (_e, r, [obj]) => obj.setRotation(coords.rot(r.angle)));

// ✅ update opts into entry-time initialization
.update({ watch: Rotation, onEnter: true, inject: [Transform] }, (_e, r, [obj]) => obj.setRotation(coords.rot(r.angle)));
```

### Injection

**Inject every component a system callback always uses.** Pull it into the callback instead of
`entity.get()`-ing it by hand:

```ts
.enter([Arc], (entity, [arc]) => { /* … */ })
.update({ watch: Arc, onEnter: true, inject: [Transform] }, (entity, arc, [obj]) => { /* … */ })
.exit([Arc, Transform], (entity, [arc, obj]) => { /* … */ })
.each([Position, Velocity], (entity, [pos, vel]) => { /* … */ })
```

Use `entity.get(C)` only for a component that is conditionally needed and rarely required: a read on
a branch most calls never take, where resolving the component for every call would be waste.

Why:

- **The signature states the inputs.** What a callback reads sits next to the `.with(...)` that
  guarantees it, not in the body.
- **No dead guards.** A component guaranteed by `.with(...)` is injected as non-nullable, so there
  is no `undefined` to check. `get` returns `Readonly<C> | undefined`, which invites an
  `if (c !== undefined)` that tells the next reader the component might be missing when the query
  says it cannot be. An injected instance is also the live, mutable one: a callback that writes in
  place and calls `entity.modified(C)` (see §7) needs no cast.
- **Resolved once.** Injection resolves a component's id when the callback is registered;
  `entity.get(C)` resolves the class on every call. In an `exit` callback injection matters more
  still: it reads the snapshot captured when the entity left, while a `get` at replay time can find
  the component already removed.

Components listed in the inject tuple but **not** guaranteed by `.with(...)` resolve as
`T | undefined` (the types reflect this) — guard them; the ones in `.with` are always present.

### Maintained state exists from creation

A component a system **maintains** (derived or projected state, such as `Thrusting` from the input
intent) exists from the moment the entity does, with its neutral value. The maintaining system
requires it in `.with(...)`, injects it and writes it in place only when the value changes. Give it
its neutral value where the entity is composed, or declare it with `With` on the component that
makes the entity relevant (`world.component(Ship).add(With, world.component(Thrusting))`, during
setup, see §3), so no creation path can forget it.

```ts
// ❌ set on first use: Thrusting is optional to every reader, and creation is split
.update({ watch: PlayerInputIntent, onEnter: true }, (entity, input) => {
  if (entity.get(Thrusting)?.on === input.thrust) return;
  if (!entity.has(Thrusting)) entity.set(Thrusting, { on: input.thrust });
  else entity.getMut(Thrusting, (t) => { t.on = input.thrust; });
})

// ✅ Thrusting { on: false } exists from creation; the system requires and injects it
.with(Ship, PlayerInputIntent, Thrusting)
.update({ watch: PlayerInputIntent, onEnter: true, inject: [Thrusting] }, (entity, input, [t]) => {
  if (t.on === input.thrust) return;
  t.on = input.thrust;
  entity.modified(Thrusting);
})
```

A set-on-first-use branch is the smell. It makes the component optional to every reader, which
then needs `get` and `?.` guards, and it moves the component's creation out of the entity's
composition. The exception is a component whose **presence** is the information: a tag or state
marker the system adds and removes is meant to come and go.

Inject `Now` or `Delta` when a system entity callback needs time, rather than capturing it in a
separate `.run` callback. They mix with component and relationship injects in any tuple position:

```ts
import { Delta } from "@vworlds/vecs";

world
  .system("Move")
  .with(Position, Velocity)
  .each([Position, Delta, Velocity], (entity, [pos, delta, vel]) => {
    pos.x += (vel.vx * delta) / 1000;
    entity.modified(Position);
  });
```

For processing-time semantics, cadence accumulation, and callback support, see
[System clock injection](./systems.md#clock-injection).

### `each` vs reactive — don't scan when you can react

- **`.each([...], cb)`** iterates **every matching entity every tick**. Use it only when you
  genuinely need a per-frame sweep over all members. An `.each` must justify running every tick: a
  body that returns early for most members is a reactive system or a narrower query in disguise.
- **Reactive `enter`/`update`/`exit`** fire only on change. For "copy A→B when A changes,"
  reactive `.update(A)` touches _nothing_ on idle entities, where `.each` would scan them all.

```ts
// ❌ scans every body every tick, even if it didn't move
.with(PhysicsPosition, RenderPosition).each([...], (e, [...]) => { if (changed) e.set(...) });

// ✅ fires only when physics actually moved the body (compare before writing a networked B: see §7)
.with(PhysicsPosition, RenderPosition).update(PhysicsPosition, (e, p) => e.set(RenderPosition, { x: p.x, y: p.y }));
```

When the work really is per-tick (a held input, a cooldown, a charge), narrow the query with a tag
or component that exists **only while the work is live**, instead of sweeping every candidate and
returning early. A reactive `update` on the intent adds and removes the marker:

```ts
// ❌ visits every shooter every tick; most return at once
.with(Weapon).each([Weapon], (e, [w]) => { if (!e.has(TriggerHeld)) return; /* fire */ });

// ✅ the cadence system matches only entities that are firing right now
world.system("TriggerIntent").with(Weapon).update(FireIntent, (e, intent) =>
  intent.held ? e.add(Firing) : e.remove(Firing));
world.system("Fire").with(Weapon, Firing).interval(0.1).each([Weapon], (e, [w]) => { /* fire */ });
```

For a countdown, do not write a bespoke "tick every timer" system over all entities. Vecs has no
per-entity timer component: `interval`, `rate` and `tickSource` (see below) throttle _systems_.
Model the window as an owned helper entity, an `Exclusive` + `OwnedTarget` relationship target that
carries the deadline (see [Owned target entities](#owned-target-entities-entity-valued-properties)).
Its presence is the window: an `.each` over the helper entities visits only open windows, and
destroying a helper ends its window and removes the edge through the relationship's cleanup policy,
so no remove hook or flag is needed.

### `run` and `interval`

- **`.run(cb)`** — a system with no per-entity query; the body runs once per tick. For
  frame-level work, external I/O, stepping an embedded simulation.
- **`.interval(seconds)`** — throttle a system to run at most every `seconds`.

### Grouped queries (indexing without scans)

`groupBy` maintains a live bucketing you can look up by key — for spatial grids, interest
management, any "find members in bucket K" need — without re-scanning each tick:

```ts
const ballsByCell = world
  .query("ByCell")
  .with(Networked, Ball, Position)
  .groupBy([Position], (_e, [p]) => cellIndex(p)); // re-buckets reactively as Position changes

ballsByCell.group(k)?.forEach([Position, Ball], (e, [p, b]) => {
  /* candidates in cell k */
});
ballsByCell.group(k)?.count;
```

### One system = one phase

A system lives in exactly **one** phase. If a concern needs part of its work earlier and part
later, **split it into multiple systems** in different phases (e.g. validation in `ON_VALIDATE`,
corrections in `POST_UPDATE`). You cannot put a system's `.exit` in one phase and its `.update` in
another.

---

## 5. Phases & ordering

- **Map your work onto the standard taxonomy** (§2). Input → `ON_LOAD`/`POST_LOAD`; gameplay →
  `ON_UPDATE`; validation → `ON_VALIDATE`; corrections → `POST_UPDATE`; render prep → `PRE_STORE`;
  output/render/send → `ON_STORE`.
- **Avoid custom phases for application/render code.** `insertPhaseAfter` exists, but it's for
  engine-level modules that genuinely need their own spine (e.g. physics inserts
  `physics-pre`/`physics-step`/`physics-post` after `ON_UPDATE`). App and render systems should
  use the built-in phases; a render system just needs to run _after_ whoever produced its inputs,
  and `PRE_STORE`/`ON_STORE` are after gameplay and physics.
- **Order within a phase = registration order**, which an umbrella module controls by the order
  it loads sub-modules. **Cross-module ordering should be expressed with phases, not registration
  order** — never rely on "module A happened to load before module B" for correctness when the two
  are independent. (Example: the server's physics-to-render pose-sync must run after the physics step → put it
  in `POST_UPDATE`, which is after the physics phases, rather than hoping the physics module loaded
  first.)

---

## 6. Modules

A module packages a feature: it registers components, systems, exclusivity, and (rarely) phases.

```ts
export class PhaserServerModule extends Module<undefined> {
  public init(): void {
    const world = this.world;
    world.setExclusiveComponents(...phaserRenderableComponents);
    world
      .system("phaser.sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(POST_UPDATE)
      .update(
        { watch: PhysicsPosition, onEnter: true, inject: [RenderPosition] },
        (e, p, [render]) => {
          if (render.x !== p.x || render.y !== p.y) {
            render.x = p.x;
            render.y = p.y;
            e.modified(RenderPosition);
          }
        }
      );
    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(POST_UPDATE)
      .update(
        { watch: PhysicsRotation, onEnter: true, inject: [RenderRotation] },
        (e, r, [render]) => {
          if (render.angle !== r.angle) {
            render.angle = r.angle;
            e.modified(RenderRotation);
          }
        }
      );
  }
}

world.module(PhaserServerModule); // registered once; init runs once
```

Guidelines:

- **Declare systems inline in `init`.** Don't write an `installFooSystem(world)` helper that just
  registers one system — it adds a layer for nothing.
- **Config flows through `world.module(M, config)`** and into `init(config)`. Keep it minimal;
  prefer zero-config when a sensible default (e.g. a standard phase) exists.
- **One module per cohesive thing.** A big feature can be **one module per item** (e.g. an
  `ArcModule`, `RectangleModule`, …) plus a thin **umbrella module** whose `init` composes them:

  ```ts
  export class PhaserRenderModule extends Module<{ scene; pixelsPerMeter? }> {
    public init(cfg): void {
      const coords = new CoordSpace(cfg.scene, cfg.pixelsPerMeter);
      this.world.component(GameObject).on("remove", (_e, obj) => obj.destroy()); // GameObject: Implements marker over every Phaser object
      this.world.module(ArcModule, { scene: cfg.scene, coords });
      this.world.module(RectangleModule, { scene: cfg.scene, coords });
      // … shape modules first …
      this.world.module(TransformStyleSyncModule, { coords }); // … then sync, so create precedes sync within ON_STORE
    }
  }
  ```

  A module's `init` can `this.world.module(Sub, subConfig)` to compose, and the **load order sets
  same-phase ordering**.

- **Modules own cross-cutting policy:** exclusivity (`setExclusiveComponents`), phase placement,
  component registration. Keep that out of application code.

### Feature modules: a recommended application layout

For medium-sized game/application code, a useful convention is to organize each cohesive feature as
a folder with one main module and a few local support files. This is **a recommendation, not a vecs
requirement**: skip the ceremony for small examples, one-off demos, or reusable library modules
where another structure is clearer.

```txt
modules/
  combat/
    module.ts
    components.ts
    factories.ts
    targeting.ts
```

Use the files like this:

| File            | Role                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module.ts`     | The feature install point: load dependencies, load local component registration, then declare systems inline in `init()`.                                                          |
| `components.ts` | Component classes owned by this feature, plus a small registration module for those classes. Omit it when the feature owns no components.                                          |
| `factories.ts`  | Optional helpers for repeated aggregate creation. Keep them thin and transparent; prefer call-site composition for simple entities, and never register components or systems here. |
| other files     | Local helpers or submodules. Keep imports acyclic; if two features need each other, extract the shared piece downward instead of creating a cycle.                                 |

Example:

```ts
class Shield {
  time = 0;
}

class CombatComponents extends Module {
  public init(): void {
    this.world.component(Shield);
  }
}

export class CombatModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(CombatComponents);
    world
      .system("combat.shield.decay")
      .with(Shield)
      .each([Shield], (entity, [shield]) => {
        shield.time -= 1;
        if (shield.time <= 0) {
          entity.remove(Shield);
        } else {
          entity.modified(Shield);
        }
      });
  }
}
```

Feature-module rules of thumb:

- **Register components you own.** If a component belongs to another feature, package, or engine
  module, load that owner module instead of registering the class again in this feature. The same
  class can be looked up idempotently, but ownership stays clear.
- **Load dependencies, don't assume them.** If a system references `C` in `.with(C)`, make sure the
  module that registers `C` has loaded before that system is declared. `world.module(DepModule)` is
  idempotent, so repeating a dependency load is fine.
- **Depend on behavior through the feature module, not its component registrar.** Loading a
  feature's `Components` module is only for data-only use: registration for factories, marker
  checks, observer systems, or test setup that intentionally excludes behavior. If your feature
  requires what that component _does_ (decay ticks, input translation, spawning, collision handling,
  rendering, etc.), load the owning feature module so its systems and policy are installed too.
- **Use modules to provide guaranteed state.** Prefer loading the module that creates a required
  singleton/resource over scattering defensive `if (!dep) throw` guards. Still guard genuinely
  optional state, including optional injections.
- **Use phases for independent ordering.** The order an umbrella module loads feature modules sets
  same-phase system order, which is useful inside one feature. Across independent features, encode
  ordering with phases.
- **Keep networked singleton-like state as an entity.** `Singleton` stores data on the component
  entity, which is a good fit for server-local world state. For replicated game state that should
  have exactly one instance, create one `Networked` gameplay entity and have the owning module
  enforce that invariant.
- **Mirror dependencies in tests.** A focused test world should load the same framework and feature
  dependencies that production relies on, or use a shared test helper for the small foundation that
  production worlds auto-register.

---

## 7. Patterns (reach for these)

### Resource-as-component lifecycle (kills the `eid → object` map)

The canonical pattern for binding an external object to entities, fully query-driven. **Attach the
live object as its own component** and let a remove hook release it — no wrapper, no side map:

```ts
// Release the resource whenever its component leaves (explicit remove or entity destroy):
world.component(Phaser.GameObjects.Arc).on("remove", (_e, obj) => obj.destroy());

// CREATE: a renderable that has no object yet
world
  .system("new.arc")
  .with(Arc)
  .without(Phaser.GameObjects.Arc)
  .phase(ON_STORE)
  .enter([Arc], (e, [arc]) => {
    const obj = scene.add.arc(0, 0, coords.len(arc.radius));
    e.attach(obj); // the GameObject is now a component, keyed by its class
  });
//        ↑ attach is flushed after this system → the entity now matches the systems below, this same tick

// UPDATE geometry on the bound object (opts into entry + change)
world
  .system("render.arc")
  .with(Arc, Phaser.GameObjects.Arc)
  .phase(ON_STORE)
  .update({ watch: Arc, inject: [Phaser.GameObjects.Arc] }, (e, arc, [obj]) =>
    obj.setRadius(coords.len(arc.radius))
  );

// TEARDOWN: when the shape data leaves (type swap) or the entity dies, drop the object.
// A component remove hook keeps this declarative — no exit system, no phase to coordinate:
world.component(Arc).on("remove", (e) => {
  if (e.has(Phaser.GameObjects.Arc)) e.remove(Phaser.GameObjects.Arc);
});
```

Why it's good: no manual map; **destroy/reset is automatic** (destroying the entity removes the
attached object → its `onRemove` releases the resource); **type changes work for free** via
exclusivity (see below). Teardown is a remove **hook**, not a system, so it fires synchronously at
the mutation site regardless of phase — no teardown-before-create ordering to get right. When many
resource types share update/teardown logic, give them a common interface with `Implements` (§10)
and query the interface instead of each concrete class.

### Exclusivity-driven type swap

With `setExclusiveComponents(...renderables)`, replacing the renderable removes the old one. The
old shape data component's remove hook drops its attached object (→ `onRemove` destroys it); the
new shape's creation system (`.with(NewShape).without(Phaser.GameObjects.NewKind).enter`) fires and
rebinds. No teardown system, no special-casing anywhere.

### Reactive sync between two component spaces

Copy `A → B`, gated on both existing (so you never _create_ `B`, you only keep an existing `B` in
sync — pure-ECS: the owner decides whether `B` exists). Use `{ onEnter: true }` when `B` must reflect
the current `A` as soon as the entity enters the sync system, inject `B` (the `.with(...)` guarantees
it, so it is non-nullable, see §4), and write only when `B` differs from `A`:

```ts
.with(PhysicsPosition, RenderPosition).update(
  { watch: PhysicsPosition, onEnter: true, inject: [RenderPosition] },
  (e, p, [render]) => {
    if (render.x !== p.x || render.y !== p.y) {
      render.x = p.x;
      render.y = p.y;
      e.modified(RenderPosition);
    }
  }
);
```

Every write is a modification, even with an equal value: both `set` and `modified` fire `onSet`,
route `update` events to every watching system and replicate a networked component. So a sync into a
networked or watched `B` compares before it writes. The injected `B` is the live instance, so assign
into it and call `entity.modified(B)`: that has the same effects as `set` without the props literal
and the deferred copy, and a second event for the same entity in one drain finds the first write
applied and writes nothing. Always pair an in-place write with `modified`: assignment alone notifies
nobody, so hooks, watchers and replication never see it. Use `set` when you do not hold the instance,
or when the write should create the component.

Leave `onEnter: true` off (or set `onEnter: false`) only when a separate `.enter(...)` already initializes `B`,
or when the callback is intentionally "future changes only."

### Relationship edges + grouped queries for spatial/interest indexing

Bucket entities by a relationship target (or a derived key) and look up buckets in O(1) instead of
scanning. `groupBy(Rel)` places a source in every bucket targeted through `Rel`; adding or removing
an edge reconciles only the affected buckets. Use `Exclusive` when the model permits one bucket and
multi-target relationships when a source legitimately belongs to several.

### Owned target entities (entity-valued properties)

Before adding a nested object to a component or a side map from owner eid to state, ask whether the
value is really one ECS sub-entity. Use an owned target when all of these are true:

- The owner has zero or one value for the concern.
- The value needs its own optional components, systems, or query identity.
- The value is exclusively owned and never shared.
- Replacement, relationship removal, and owner destruction should destroy it.

```ts
class Inventory extends Relationship {}
class InventoryState {}
class Capacity {
  slots = 0;
}
class Weight {
  current = 0;
}

world.component(Inventory).add(Exclusive).add(OwnedTarget);
world.component(InventoryState);
world.component(Capacity);
world.component(Weight);

const inventory = world.entity();
player.add(Inventory, inventory);
inventory.add(InventoryState).set(Capacity, { slots: 20 }).set(Weight, { current: 0 });
```

`Inventory` is an entity-valued property of `player`, but it remains entirely inside the ECS.
Inventory systems operate on inventory entities without adding inventory-specific state to every
player archetype:

```ts
world
  .system("inventory.weight")
  .with(InventoryState, Weight)
  .each([Weight], (_inventory, [weight]) => {
    void weight.current;
  });
```

The lifecycle follows from the relationship and trait:

| Operation                             | Result                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `player.add(Inventory, inventory)`    | Parents the explicit inventory entity                                     |
| `player.add(Inventory, replacement)`  | Destroys the displaced inventory                                          |
| `player.remove(Inventory, inventory)` | Destroys that inventory and removes `Inventory` when it was the sole edge |
| `player.remove(Inventory)`            | Destroys every current target                                             |
| Destroy `player`                      | `ChildOf` destroys the inventory                                          |

Prefer this to a component field that holds the child entity, with an `onRemove` hook that destroys
it. Every operation that drops the edge destroys the child, and destroying the child directly
removes the edge, so the owner needs no hook and holds nothing that can go stale (see
[Link with edges, not stored ids](./relationships.md#link-with-edges-not-stored-ids)).

Inside deferred execution, keep and mutate the target you created; the queued edge is not visible
through `target` until flush:

```ts
world.defer(() => {
  const inventory = world.entity();
  player.add(Inventory, inventory);
  inventory.set(Capacity, { slots: 20 }); // the newly created entity is usable
  player.target(Inventory); // still undefined until flush
});
```

Use the narrowest model that fits:

| Need                                                | Model                                         |
| --------------------------------------------------- | --------------------------------------------- |
| A few fields sharing the owner's identity/lifecycle | Components directly on the owner              |
| One composable, exclusively owned sub-entity        | Explicit target + `Exclusive` + `OwnedTarget` |
| One shared or independently living linked entity    | Relationship without `OwnedTarget`            |
| Zero-to-many subobjects                             | Child entities with identifying components    |
| A non-ECS runtime object                            | `attach(instance)`                            |
| World-global state                                  | Singleton/component entity                    |

Good fits include an inventory aggregate, equipment loadout, character progression sheet, AI
blackboard, quest journal, ability book, or unique vehicle subsystem. Individual inventory items,
abilities, objectives, and other collections should remain separate entities. Networking remains
explicit: register the relationship and replicate the target's required components; `OwnedTarget`
itself is local lifecycle policy.

### Initialize via opt-in `update`-on-entry

When an update callback owns both initialization and later changes, pass `{ onEnter: true }`. The
"apply current value when the entity appears" step then needs no separate `enter` — just order the
system after whatever produces the entity/companion.

---

## 8. Anti-patterns (keep ECS semantics)

| Smell                                                                  | Do instead                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A side `Map<eid, resource>`                                            | Store the resource in a **companion component**; let queries drive its lifecycle; release in `onRemove`.                                             |
| An imperative runtime object with `start()/stop()/track/enable`        | A **module** + the world's own lifecycle (`clearAllEntities()`, closing the world). Systems live on the world; they don't need a wrapper to turn on. |
| Builder/factory helpers that _create entities_ (`createArc(world, …)`) | Let callers `world.entity().add(Networked).set(Arc, …).set(FillStyle, …)`. Components are small and optional; the caller adds exactly what it wants. |
| A god component with many optional fields                              | Split into small single-purpose components; absence encodes "not applicable."                                                                        |
| A large nested `inventory`, `brain`, or progression object             | Use an owned target entity when the subobject needs its own components, systems, and lifecycle.                                                      |
| A side `Map<ownerEid, SubsystemState>`                                 | Create a target entity and add an explicit edge; use `Exclusive` + `OwnedTarget` only for destructive ownership.                                     |
| An `eid` or `Entity` stored in a component field as a link             | A relationship edge: vecs cleans it up; a stored eid can name another entity once reused ([why](./relationships.md#link-with-edges-not-stored-ids)). |
| A component field holding a child entity, destroyed in `onRemove`      | `Exclusive` + `OwnedTarget`: dropping the edge destroys the child; no hook, no stale field ([§7](#owned-target-entities-entity-valued-properties)).  |
| `entity.destroyed` guards on an entity looked up from a stored link    | A missing edge: replace the link. Keep checks for event buffers; writes need none ([why](./relationships.md#link-with-edges-not-stored-ids)).        |
| `OwnedTarget` on `CurrentEnemy`, `InCell`, `Team`, or shared state     | Use a normal relationship; replacing or removing an owned edge destroys its target.                                                                  |
| One owned target used as a collection                                  | Use multiple child/item entities; owned targets model zero-or-one aggregates.                                                                        |
| Duplicated `enter` + `update` doing the same thing                     | One `update({ watch: C, onEnter: true })` when update owns initialization.                                                                           |
| One system trying to act in two phases                                 | Split into two systems, one per phase.                                                                                                               |
| Custom phases for app/render logic                                     | Use the standard taxonomy; only engine modules insert phases.                                                                                        |
| `.each` scanning every entity to detect change                         | Reactive `.update(C)` — fires only on change.                                                                                                        |
| `entity.get(C)` for a component the callback always uses               | Inject it (`inject: [C]`); keep `get` for a component that is conditionally needed and rarely required.                                              |
| `has`/`set` on first use of state a system maintains                   | Create it with its neutral value (or via `With`); require it in `.with` and inject it ([§4](#maintained-state-exists-from-creation)).                |
| Treating target storage as component data                              | Use `add(Rel, target)` / `remove(Rel, target)` and read with `target` / `targets` / `hasTarget`; target storage is private.                          |
| A `registerFooSystem(world)` wrapper per system                        | Declare the system inline in the module's `init`.                                                                                                    |

---

## 9. Pitfalls / gotchas checklist

- **A system is in exactly one phase.** Plan splits accordingly.
- **Structural changes are deferred and flushed _after_ each system** — visible to later systems
  this tick, not to the current system mid-iteration.
- **`update(C)` is change-only by default.** Add `{ onEnter: true }` for projection/sync callbacks
  that must apply the current watched value on entry; leave it off for mutation-only callbacks or
  when `.enter(...)` already owns initialization.
- **A write marks the component modified, even with an equal value.** `set`, and an in-place
  assignment followed by `modified`, fire `onSet`, route `update` events to every watching system and
  replicate a networked component. A writer that runs every tick and copies a value into a networked
  or watched component (simulation output, a derived pose) should compare first and write only when
  the value changed (see §7). An in-place assignment without `modified` notifies nobody.
- **`getMut` marks the component modified even without a callback and even if you write nothing.**
  Calling it every tick fires `onSet`, `update` watchers and replication every tick. Read with `get`;
  call `getMut` only when a change is intended (see
  [`getMut` and `ensure`](./entities.md#getmut-and-ensure-mutating-in-place)).
- **A callback that always uses a component should inject it, not `get` it.** `entity.get(C)` is for
  a component that is conditionally needed and rarely required (see §4).
- **Membership is fixed by `.with(...)` / `.without(...)` / `.update(C)`;** `update(C)` watches `C`
  and requires it.
- **A system's `enter` reaches only entities still in its query when the system drains.** One that
  left or died first gets neither `enter` nor the paired `exit`, and one that leaves and re-enters
  within a drain gets `enter`, `exit`, `enter`, so keep `enter` setup and `exit` teardown symmetric
  (see [`.enter`](./systems.md#entercallback--enterinject-callback--enteroptions-callback)).
- **`exit` retains injected references captured at exit** (components are not deep-cloned).
- **A `remove` hook also fires while the entity is being destroyed,** with `entity.destroyed`
  already `true`. Write to its own entity without a guard in a `remove` hook or `exit`: every write,
  including `ensure`, is silently dropped on a dying entity; `ensure` returns a fresh inert
  instance when needed, and any writes to it are discarded
  ([#423](https://github.com/vworlds/vecs/issues/423)). Check `destroyed` only to skip other
  pointless or unsafe work, such as re-projecting a view, refreshing other entities, or releasing
  shared state. In `exit`, it distinguishes death from merely leaving the query (see §4).
  A check on an entity looked up from a stored link still signals a missing edge (see §8 and
  [Hooks](./components.md#hooks-component-and-relationship-edges)).
- **Release resources in `remove` hooks, not in a system's `exit` callback.** `world.dispose()`
  runs hooks during teardown, but a system's `exit` callback only queues its event and may not
  run before infrastructure is destroyed (see
  [Disposing a world](./entities.md#disposing-a-world)).
- **Request shutdown in a system; dispose after the tick.** For allowed call sites and refusal
  behavior, see [Disposing a world](./entities.md#disposing-a-world). No core tick or mutation
  boundary performs disposal for you.
- **Within a phase, order = registration order;** across phases, the spine guarantees order. Don't
  use registration order for cross-module correctness — use phases.
- **Networked component order = wire protocol.** Reordering breaks the protocol.
- **`@wireType` must survive esbuild's standard decorators** when components load from
  source (tsx/Vite). Otherwise fields silently don't register.
- **Relationships are multi-target by default.** `target(R)` returns one current target for singular
  code but is not a stable selection policy; `targets(R)` snapshots all targets with unspecified
  ordering; `hasTarget(R, target)` tests one edge.
- **Relationship edges are explicit.** Add with `add(R, target)`, remove one with
  `remove(R, target)`, and remove all with `remove(R)`. Do not use `set` for target storage.
- **Relationship removal hooks differ in scope.** `on("targetRemove")` fires once per removed edge;
  `on("remove")` fires once, when the relationship component itself leaves, with no targets left on
  the instance (see [Edge hooks](./relationships.md#edge-hooks)).
- **Relationship cardinality and component exclusivity are different.** Add the `Exclusive` trait
  to a relationship for at-most-one target; use `setExclusiveComponents` for mutually exclusive
  component types.
- **Target queries are existential.** `{ target: [R, q] }` matches when any `R` target matches `q`.
  Singular `{ target: ... }` injection projects one current target; plural `{ targets: ... }`
  injection returns one projected row per target.
- **Relationship grouping is multi-bucket.** `groupBy(R)` places an entity in every current target
  bucket and reconciles buckets as edges change.
- **Network relationship snapshots contain all targets.** Register the relationship in
  `networkComponents`; the client reconciles the full edge set and relationship data.
- **Component traits have trait-specific setup semantics.** In particular, configure `OwnedTarget`
  before creating relationship instances; it does not backfill.
- **`OwnedTarget` requires `Exclusive` and explicit target creation.** Replacing an edge destroys
  the old target, removing the relationship destroys the current target, and owner destruction
  cascades through `ChildOf`.
  Never use it for shared teams, cells, enemies, definitions, or other world entities.
- **`Traversable` requires `Exclusive`.** Depth and cascade ordering need one parent per source.
- **Owned targets are zero-or-one.** Use child entities for collections, create the aggregate target
  explicitly, and during deferred execution keep that entity instead of re-reading `target(R)`
  before flush.
- **`world.module(M)` runs `init` once.** Re-registering with a different config throws.
- **vecs-phaser: a `DrawBy` child follows only its parent's `Position`.** It turns with the parent
  only with `InheritRotation`, which makes the resolver derive its `Rotation` every frame, so
  writing `Rotation` on a tagged child has no effect (see
  [Turning with the parent](../../vecs-phaser-client/README.md#turning-with-the-parent)).
- **vecs-phaser: `DrawBy` and `DrawIn` use `CleanupPolicy.Remove`,** so destroying a display parent
  detaches its children instead of destroying them, unlike `ChildOf`, which deletes them. A display
  child that must die with its parent also needs `ChildOf` to it, or must be its owned target (see
  [Destroying the display parent](../../vecs-phaser-client/README.md#destroying-the-display-parent)).
- **vecs-physics, vecs-phaser-server: pose writes are change-only.** `set` hooks and `update` systems
  on the physics and render pose fire when the pose changed, not on every step; to visit every body
  every step, iterate with `each` (see
  [Pose Updates Fire Only When The Pose Changes](../../vecs-physics/docs/systems-and-phases.md#pose-updates-fire-only-when-the-pose-changes)).
- **vecs-phaser-server: game code owns the physics pose; the render pose is protocol-private.** On
  the server, read and write the physics `Position` and `Rotation` of every entity, including one
  without a `Body`. The render `Position` and `Rotation` and the dead-reckoning `Motion` and
  `MotionParams` are wire encodings of that pose that only the sync systems write: a `DeadReckoned`
  body has no render pose at all, and adding one throws (see
  [Dead reckoning](../../vecs-phaser-server/README.md#dead-reckoning)).
- **vecs-phaser-server: switch `DeadReckoned` on a change of state, and keep a constantly driven body
  streamed.** The tag may be added or removed at any time, so a body can be dead reckoned while it
  drifts and streamed while joints, thrust or a tow drive it (a driven body diverges from its
  prediction every step and would cost a baseline of about 27 bytes per step against about 22 for a
  streamed pose update). Toggle it when the state changes, not every frame: each switch costs a
  baseline one way and a pose update the other, and clients blend the hand-off over `blendMs`
  of render-loop time, even while the replicated-state `renderFrame` holds. A
  render pose or `Motion` created or switched late in a frame, in `PRE_STORE`, `ON_STORE` or an RPC
  handler, is still synced from the physics pose before the frame is recorded (see
  [Switching at runtime](../../vecs-phaser-server/README.md#switching-at-runtime)).
- **vecs-client: attach a `ClientWorld` socket only after `socket.connect()` resolves,** so no ack
  precedes the data channel (`connectDgram` does this). Pending `invoke` calls reject with
  `RPC_CLOSED_CODE` on disconnect or `dispose` (see
  [Connecting](../../vecs-client/docs/client-world.md#connecting) and
  [Disconnection and disposal](../../vecs-client/docs/client-world.md#disconnection-and-disposal)).
- **vecs-physics: component fields hold plain data,** never Box2D wrappers or other class
  instances. `set` accepts them, but snapshot capture (`snapshotSubtree`, `moveSubtree`) rejects
  non-plain values (see
  [Keep Component Fields Plain Data](../../vecs-physics/docs/components.md#keep-component-fields-plain-data)).

---

## 10. Case study: the Phaser render layer

A compact tour that uses everything above. Goal: the server owns authoritative entities with
small **render components**; the client turns them into Phaser `GameObject`s with **no per-entity
render code**.

- **Data (`@vworlds/vecs-phaser`):** small, single-purpose, networked components — `Position`,
  `Rotation`, `Scale`, `Alpha`, `Depth`, `FillStyle`, `StrokeStyle`, `Size`, and one-of-N
  renderables (`Arc`, `Rectangle`, `Text`, …). `networkComponents` order is the protocol.
- **Server (`PhaserServerModule`, zero-config):** owns exclusivity
  (`setExclusiveComponents(...renderables)`); two **reactive** pose-sync systems in `POST_UPDATE`
  copy physics `Position`/`Rotation` → render pose only when physics moved (`.update`, not
  `.each`), and only for entities that already have a render pose (no creation — pure ECS). No
  builders: game code creates entities and adds the components it wants.
- **Client (`PhaserRenderModule` umbrella → per-shape modules):** the live Phaser object is
  attached to its entity **as the component** (`entity.attach(obj)`) — no wrapper. Each concrete
  Phaser class declares the **interface markers** it satisfies with `Implements` (`GameObject`,
  `Transform`, `Fill`, … plus a geometry marker like `Arc`/`Vertices`/`Text`), so one set of
  systems drives every renderable polymorphically. Per shape: a **creation** system
  (`.with(Shape).without(Phaser.GameObjects.Kind).enter` → `scene.add.*` + `entity.attach`) in
  `ON_STORE`; a **geometry** system (`.with(Shape, m.Geometry).update`) in `ON_STORE`; and a
  shape-data **remove hook** (`component(Shape).on("remove", ...)` → remove the Phaser object) instead of a
  teardown system. Shared transform/style **sync** systems
  (`.with(Component, m.Marker).update({ watch: Component, onEnter: true })`) apply
  position/rotation/scale/alpha/depth/size/fill/stroke through the markers — initialization is
  explicit via `onEnter: true`, and the umbrella loads shape modules _before_ the sync module so
  creation precedes sync within `ON_STORE`.
- **Lifecycle that falls out for free:** destruction is a single hook —
  `component(GameObject).on("remove", (_e, obj) => obj.destroy())`. A renderable **type swap**
  (exclusivity removes the old shape data → its remove hook drops the attached object → it's
  destroyed → the new shape's creation system rebinds) and a **baseline reset / disconnect**
  (`clearAllEntities()` → entities destroyed → attached objects removed → destroyed) both work with
  no maps, no `start/stop`, no reset handler.

The whole thing is "server says _what exists, where, and what it looks like_; the client owns the
Phaser lifecycle" — expressed entirely as small components + phased reactive systems + modules.

---

_Keep components small and dumb, let systems and phases express behavior and order, store
resources in components, react to change instead of scanning, and package it as modules. When a
design starts growing maps, factories, and start/stop wrappers, that's the signal you've stepped
outside ECS — step back in._
