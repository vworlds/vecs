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

Mark wire fields with `@type` from `@vworlds/vecs-wire` (conventionally imported as
`import { type as wireType }`). The
**order** you pass components in `networkComponents` _is the wire protocol_ (type id = index + 1).
Reordering is a breaking protocol change — snapshot-test the order.

```ts
class Arc {
  @wireType("f32") radius = 0.5;
}
new ServerWorld({ networkComponents: [Position, Rotation, /* … */ Arc] });
```

> **Decorator gotcha.** `@type` must work under both _legacy_ (`experimentalDecorators`, used by
> `tsc`) and _standard_ TC39 decorators (what esbuild — `tsx`/Vite — emits for source files).
> If you load decorated component classes from **source** through an esbuild-based runtime and
> their fields silently fail to register, that's the standard-vs-legacy mismatch. vecs-wire
> supports both; if you author new decorators, preserve that.

### Companion / wrapper components (hold non-ECS resources)

To attach a non-ECS resource (a Phaser `GameObject`, a WASM handle, a DOM node) to an entity,
**wrap it in a local, non-networked component** instead of keeping a side `Map<eid, resource>`.
The entity's component set _is_ the lifecycle; queries drive create/destroy; reset is free.

```ts
export class VGameObject {
  obj!: Phaser.GameObjects.GameObject;
}

world.component(VGameObject).onRemove((_entity, vgo) => vgo.obj.destroy());
```

`onRemove` (below) releases the resource whenever the component leaves — whether removed
explicitly or because the entity was destroyed.

### Component lifecycle hooks: `onAdd` / `onSet` / `onRemove`

`world.component(C)` returns a handle with hooks fired on every entity:

```ts
world.component(Impulse).onSet((entity, impulse) => {
  /* accumulate */
});
world.component(VGameObject).onRemove((_entity, vgo) => vgo.obj.destroy());
```

Use them for resource management and cross-cutting reactions that aren't worth a system. (Note
the difference from systems: hooks are per-component-instance and run at the mutation site;
systems are queries that run in a phase.)

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

A relationship is a component whose value points at another entity:

```ts
class InCell extends Relationship {}
entity.set(InCell, { target: cell }); // retarget freely
entity.target(InCell); // the target entity
world.query("ByCell").with(Networked, Position).groupBy(InCell); // index by target
```

- **`Relationship.target` is an `Entity` — not serializable, so relationships are not
  networkable.** Don't try to replicate them.
- **Retargeting is a plain data change** (no archetype churn). Prefer retargeting a relationship
  over swapping marker components to express "which bucket this entity is in."

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

### Reactive callbacks: `enter` / `update` / `exit`

- **`enter`** — fires once when an entity _becomes_ a member. Use it for one-time setup
  (create the resource).
- **`update(C, …)`** — adds `C` to the predicate and fires when watched component `C` is modified.
  **It also fires on entry for every already-present watched component** (`System._enter` re-pushes
  update events for watched components). So `.update(C)` initializes on entry _and_ reacts to
  changes — **don't write a separate `.enter` that duplicates the same logic.**
- **`exit`** — fires when an entity stops matching (a component removed, or the entity destroyed).
  Its injected components are read from a **snapshot captured at exit time**, so they're still
  resolvable even though they're being removed.

```ts
// ❌ redundant
.enter([Rotation, VGameObject], (_e, [r, vgo]) => vgo.obj.setRotation(coords.rot(r.angle)))
.update({ component: Rotation, inject: [VGameObject] }, (_e, r, [vgo]) => vgo.obj.setRotation(coords.rot(r.angle)));

// ✅ update fires on entry too
.update({ component: Rotation, inject: [VGameObject] }, (_e, r, [vgo]) => vgo.obj.setRotation(coords.rot(r.angle)));
```

### Injection

Pull components into the callback instead of `entity.get()`-ing them by hand:

```ts
.enter([Arc], (entity, [arc]) => { /* … */ })
.update({ component: Arc, inject: [VGameObject] }, (entity, arc, [vgo]) => { /* … */ })
.exit([Arc, VGameObject], (entity, [arc, vgo]) => { /* … */ })
.each([Position, Velocity], (entity, [pos, vel]) => { /* … */ })
```

Components listed in the inject tuple but **not** guaranteed by `.with(...)` resolve as
`T | undefined` (the types reflect this) — guard them; the ones in `.with` are always present.

### `each` vs reactive — don't scan when you can react

- **`.each([...], cb)`** iterates **every matching entity every tick**. Use it only when you
  genuinely need a per-frame sweep over all members.
- **Reactive `enter`/`update`/`exit`** fire only on change. For "copy A→B when A changes,"
  reactive `.update(A)` touches _nothing_ on idle entities, where `.each` would scan them all.

```ts
// ❌ scans every body every tick, even if it didn't move
.with(PhysicsPosition, RenderPosition).each([...], (e, [...]) => { if (changed) e.set(...) });

// ✅ fires only when physics actually moved the body
.with(PhysicsPosition, RenderPosition).update(PhysicsPosition, (e, p) => e.set(RenderPosition, { x: p.x, y: p.y }));
```

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
later, **split it into multiple systems** in different phases (e.g. teardown in `PRE_STORE`,
build in `ON_STORE`). You cannot put a system's `.exit` in one phase and its `.update` in another.

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
  are independent. (Example: teardown must run before creation across all shapes → put teardown
  in `PRE_STORE` and creation in `ON_STORE`; then it holds no matter which shape module loaded
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
      .phase(PRE_STORE)
      .update(PhysicsPosition, (e, p) => e.set(RenderPosition, { x: p.x, y: p.y }));
    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(PRE_STORE)
      .update(PhysicsRotation, (e, r) => e.set(RenderRotation, { angle: r.angle }));
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
      this.world.component(VGameObject).onRemove((_e, vgo) => vgo.obj.destroy());
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

---

## 7. Patterns (reach for these)

### Resource-as-component lifecycle (kills the `eid → object` map)

The canonical pattern for binding an external object to entities, fully query-driven:

```ts
class VGameObject {
  obj!: RenderObject;
}
world.component(VGameObject).onRemove((_e, vgo) => vgo.obj.destroy()); // release on remove/destroy

// CREATE: a renderable that has no object yet
world
  .system("new.arc")
  .with(Arc)
  .without(VGameObject)
  .phase(ON_STORE)
  .enter([Arc], (e) => {
    const obj = scene.add.arc(0, 0);
    e.set(VGameObject, { obj });
  });
//        ↑ set(VGameObject) is flushed after this system → the entity now matches the systems below, this same tick

// UPDATE geometry on the bound object (fires on entry + on change)
world
  .system("render.arc")
  .with(Arc, VGameObject)
  .phase(ON_STORE)
  .update({ component: Arc, inject: [VGameObject] }, (e, arc, [vgo]) =>
    (vgo.obj as ArcObject).setRadius(coords.len(arc.radius))
  );

// TEARDOWN: when the shape leaves (type swap) or the entity dies, drop the companion → onRemove destroys
world
  .system("teardown.arc")
  .with(Arc, VGameObject)
  .phase(PRE_STORE)
  .exit([Arc, VGameObject], (e) => {
    if (e.has(VGameObject)) e.remove(VGameObject);
  });
```

Why it's good: no manual map; **destroy/reset is automatic** (destroying the entity removes
`VGameObject` → `onRemove` releases the resource); **type changes work for free** via exclusivity
(see below). Note the ordering: teardown in `PRE_STORE` runs before creation in `ON_STORE`, so an
`Arc → Rectangle` swap removes the old companion _before_ the new shape's `.without(VGameObject)`
creation query runs — same frame.

### Exclusivity-driven type swap

With `setExclusiveComponents(...renderables)`, replacing the renderable removes the old one. The
old shape's teardown system (`.with(OldShape, VGameObject).exit`) fires and drops the companion;
the new shape's creation system (`.with(NewShape).without(VGameObject).enter`) fires and rebinds.
No special-casing anywhere.

### Reactive sync between two component spaces

Copy `A → B` only when `A` changes, gated on both existing (so you never _create_ `B`, you only
keep an existing `B` in sync — pure-ECS: the owner decides whether `B` exists):

```ts
.with(PhysicsPosition, RenderPosition).update(PhysicsPosition, (e, p) => e.set(RenderPosition, { x: p.x, y: p.y }));
```

### Relationship retargeting + grouped queries for spatial/interest indexing

Bucket entities by a relationship target (or a derived key) and look up buckets in O(1) instead of
scanning. Moving between buckets is a retarget (data change), not a component swap.

### Initialize via `update`-on-entry

Because `update(C)` fires on entry, the "apply current value when the entity appears" step needs
no separate `enter` — just order the system after whatever produces the entity/companion.

---

## 8. Anti-patterns (keep ECS semantics)

| Smell                                                                  | Do instead                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A side `Map<eid, resource>`                                            | Store the resource in a **companion component**; let queries drive its lifecycle; release in `onRemove`.                                             |
| An imperative runtime object with `start()/stop()/track/enable`        | A **module** + the world's own lifecycle (`clearAllEntities()`, closing the world). Systems live on the world; they don't need a wrapper to turn on. |
| Builder/factory helpers that _create entities_ (`createArc(world, …)`) | Let callers `world.entity().add(Networked).set(Arc, …).set(FillStyle, …)`. Components are small and optional; the caller adds exactly what it wants. |
| A god component with many optional fields                              | Split into small single-purpose components; absence encodes "not applicable."                                                                        |
| Duplicated `enter` + `update` doing the same thing                     | One `update(C)` — it fires on entry too.                                                                                                             |
| One system trying to act in two phases                                 | Split into two systems, one per phase.                                                                                                               |
| Custom phases for app/render logic                                     | Use the standard taxonomy; only engine modules insert phases.                                                                                        |
| `.each` scanning every entity to detect change                         | Reactive `.update(C)` — fires only on change.                                                                                                        |
| Networking a relationship                                              | You can't (target is an `Entity`); replicate a plain id/tag instead, or keep the relationship server-local.                                          |
| A `registerFooSystem(world)` wrapper per system                        | Declare the system inline in the module's `init`.                                                                                                    |

---

## 9. Pitfalls / gotchas checklist

- **A system is in exactly one phase.** Plan splits accordingly.
- **Structural changes are deferred and flushed _after_ each system** — visible to later systems
  this tick, not to the current system mid-iteration.
- **`update(C)` fires on entry** for already-present watched components. Lean on it; don't
  duplicate in `enter`.
- **Membership is fixed by `.with(...)` / `.without(...)` / `.update(C)`;** `update(C)` watches `C`
  and requires it.
- **`exit` reads a snapshot** of the injected components captured at exit (they're being removed).
- **Within a phase, order = registration order;** across phases, the spine guarantees order. Don't
  use registration order for cross-module correctness — use phases.
- **Networked component order = wire protocol.** Reordering breaks the protocol.
- **`@type`/`@wireType` must survive esbuild's standard decorators** when components load from
  source (tsx/Vite). Otherwise fields silently don't register.
- **`Relationship.target` is an `Entity`** — not wire-encodable.
- **`world.module(M)` runs `init` once.** Re-registering with a different config throws.

---

## 10. Case study: the Phaser render layer

A compact tour that uses everything above. Goal: the server owns authoritative entities with
small **render components**; the client turns them into Phaser `GameObject`s with **no per-entity
render code**.

- **Data (`@vworlds/vecs-phaser`):** small, single-purpose, networked components — `Position`,
  `Rotation`, `Scale`, `Alpha`, `Depth`, `FillStyle`, `StrokeStyle`, and one-of-N renderables
  (`Arc`, `Rectangle`, `Text`, …). `networkComponents` order is the protocol.
- **Server (`PhaserServerModule`, zero-config):** owns exclusivity
  (`setExclusiveComponents(...renderables)`); two **reactive** pose-sync systems in `PRE_STORE`
  copy physics `Position`/`Rotation` → render pose only when physics moved (`.update`, not
  `.each`), and only for entities that already have a render pose (no creation — pure ECS). No
  builders: game code creates entities and adds the components it wants.
- **Client (`PhaserRenderModule` umbrella → per-shape modules):** binds each entity's renderable
  to a Phaser object stored in the **`VGameObject` companion component** (`onRemove → destroy`).
  Per shape: a **creation** system (`.with(Shape).without(VGameObject).enter` → `scene.add.*` +
  `set(VGameObject)`) in `ON_STORE`; a **geometry** system (`.with(Shape, VGameObject).update`)
  in `ON_STORE`; a **teardown** system (`.exit → remove VGameObject`) in `PRE_STORE`. Shared
  transform/style **sync** systems (`.with(Component, VGameObject).update(Component)`) apply
  position/rotation/scale/alpha/depth/fill/stroke — initialization comes for free because
  `update` fires on entry, and the umbrella loads shape modules _before_ the sync module so
  creation precedes sync within `ON_STORE`.
- **Lifecycle that falls out for free:** a renderable **type swap** is handled by exclusivity +
  teardown(`PRE_STORE`)-before-create(`ON_STORE`); a **baseline reset / disconnect** is just
  `clearAllEntities()` → entities destroyed → `VGameObject` removed → `onRemove` destroys the
  Phaser objects. No maps, no `start/stop`, no reset handler.

The whole thing is "server says _what exists, where, and what it looks like_; the client owns the
Phaser lifecycle" — expressed entirely as small components + phased reactive systems + modules.

---

_Keep components small and dumb, let systems and phases express behavior and order, store
resources in components, react to change instead of scanning, and package it as modules. When a
design starts growing maps, factories, and start/stop wrappers, that's the signal you've stepped
outside ECS — step back in._
