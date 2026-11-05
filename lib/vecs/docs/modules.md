# Modules

Package components, systems, and policy into reusable units, compose them, and meet the built-in
modules every world installs.

## What a module is

A `Module` (`lib/vecs/src/module.ts`) is a plain object whose `init()` method runs once when the
module is registered. It is the unit of packaging for a feature: registering components, declaring
systems, setting exclusivity and cleanup policy, and (rarely) inserting phases. A module is not an
entity. It has two fields: `this.world`, the world that installed it, and `this.entity`, its
class's definition entity.

```ts
import { Module, POST_UPDATE } from "@vworlds/vecs";

export class PoseSyncModule extends Module {
  public init(): void {
    const world = this.world;
    world.component(PhysicsPosition);
    world.component(RenderPosition);
    world
      .system("sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(POST_UPDATE)
      .update({ watch: PhysicsPosition, onEnter: true }, (e, p) =>
        e.set(RenderPosition, { x: p.x, y: p.y })
      );
  }
}

world.module(PoseSyncModule);
```

`world.module(ModuleClass, config?, eid?)` (`lib/vecs/src/world/world.modules.ts`) installs the
module on the first call. It registers `ModuleClass` as a component type, drawing the definition
entity's id from the `module` pool (900–999 by default, or pass an explicit `eid`). It then
constructs the module with `world` and `entity`, stores it on that entity as the class's
`Singleton` value, and invokes `init(config)` exactly once. The call returns the module instance,
not an entity; `world.component(M)` returns the definition entity, the same as `mod.entity`.
Subsequent calls return the existing module instance; passing a config again after the first
registration throws. `world.get(M)` returns `world.module(M)`, and `world.has(M)` reports whether
that value is present.

Installation also tags the definition entity with the built-in `ModuleDef` marker
(`lib/vecs/src/component_def.ts`), core modules included. Every definition carries `ComponentDef`;
only installed modules also carry `ModuleDef`. Identify a module's definition with
`entity.has(ModuleDef)`, and enumerate installed modules with
`world.query("Modules").with(ModuleDef).build()`. A class registered with `world.component(M)` but
never passed to `world.module` is not tagged. `ModuleDef` is local schema metadata, like
`ComponentDef`: excluded from subtree snapshots and rejected in `networkComponents`. Snapshots
never capture a module value: installation declares `snapshotPolicy(DontSnapshot)` on the
definition entity, like any other component, so live module instances are never captured or
restored as data.
Install new modules outside `progress()` and `defer`; installation also throws during a command
drain, before registering anything. Looking up an already installed module works in any of those
contexts. Lazy loading from a system or hook is the application's job: schedule it after
`progress()` returns.

## The module entity is not for gameplay data

Use `this.entity` for module scope and hooks: `this.entity.on("remove", ...)`, or as the parent of
the entities the module creates. Do not store gameplay or per-frame data on it. Keep that state on
game entities or on [singleton components](./components.md#singletons-and-world-global-data).

Why: every entity runs through the same per-entity write path (`set`, `modified`, hook and query
routing). V8 optimizes that path while it sees one entity shape. Every `Entity` shares one class
and one hidden class, and modules and component definitions do not subclass it, so the path stays
monomorphic. Module code that writes data through module entities adds no entity classes, but it
mixes setup-time metadata into the hot path for no benefit, and the module's data then lives on a
definition rather than with the gameplay it describes.

## Configuration

Type the config through the `Module<Config>` parameter; it flows from `world.module(M, config)`
into `init(config)`:

```ts
export class RenderModule extends Module<{ scene: Scene; pixelsPerMeter?: number }> {
  public init(cfg: { scene: Scene; pixelsPerMeter?: number }): void {
    const ppm = cfg.pixelsPerMeter ?? 32;
    // ...
  }
}

world.module(RenderModule, { scene });
```

For `Module<undefined>` (the default), the config argument is omitted. Keep configs minimal;
prefer zero-config when a sensible default exists.

## Composition and umbrella modules

A module's `init` can register sub-modules with `this.world.module(Sub, subConfig)`. A big feature
is often one module per item plus a thin umbrella that composes them:

```ts
export class PhaserRenderModule extends Module<{ scene: Scene }> {
  public init(cfg: { scene: Scene }): void {
    this.world.component(GameObject).on("remove", (_e, obj) => obj.destroy()); // GameObject: Implements marker over every Phaser object
    this.world.module(ArcModule, { scene: cfg.scene });
    this.world.module(RectangleModule, { scene: cfg.scene });
    // … shape modules first …
    this.world.module(TransformSyncModule, {}); // … then sync, so create precedes sync within a phase
  }
}
```

**Load order sets same-phase order.** Systems in the same phase run in creation order, so the
order an umbrella loads sub-modules is the order their systems run within a shared phase. Use
that for intra-feature ordering — but express **cross-module** ordering with phases, never with
load order (see [Execution model](./execution-model.md#ordering-guarantees)).

Guidelines:

- **Declare systems inline in `init`.** A `registerFooSystem(world)` helper per system is a layer
  for nothing.
- **Modules own cross-cutting policy** — `setExclusiveComponents`, cleanup policies, phase
  placement, component registration. Keep that out of application code.
- **One module per cohesive thing.** Don't pile unrelated features into one `init`.

## Scopes and module provenance

`world.scope(parent, fn)` assigns `ChildOf parent` to entities created **synchronously in its body**:
plain entities, components, modules, query/system backing entities, and phases.
Nested scopes restore the caller's parent in `finally`, even when the callback throws. Enter scopes
outside deferred mode: `world.scope()` throws inside `progress()`, a `defer` block, or a command
drain, without running the callback. Scoped creations use `.childOf(parent)` before their creation
notification. Existing name/id/class lookups do not reparent anything. An explicit
`.childOf(other)` afterwards replaces the scope parent, just as any other exclusive `ChildOf` edge.
The parent must be live and belong to the same world. Async continuations are outside the scope.

Entities created by callbacks that vecs runs deferred inside the body are **not parented**. This
includes `query.forEach(cb)`, a query's `enter` backfill when built, and an explicit `world.defer`
inside a module's `init`. Callback-created entities are run-time data: the same callback outside the
scope would not parent them either. For example, a module's `enter` or `forEach` callback may create
one health-bar entity per existing ship. Those health bars remain roots; an entity created directly
in `init` is a child of the module.

```ts
import { Entity, Module, ModuleDef, World } from "@vworlds/vecs";

class Position {}
class Feature extends Module {
  public init(): void {
    this.world.component(Position);
    this.world.entity("camera");
  }
}
const world = new World();
const feature = world.module(Feature);
world.component(Position).parent === feature.entity; // true
world.entity("camera").parent === feature.entity; // true

function owningModule(entity: Entity): Module | undefined {
  const visited = new Set<Entity>();
  for (let parent = entity.parent; parent && !visited.has(parent); parent = parent.parent) {
    if (parent.has(ModuleDef)) {
      return parent.get(parent) as Module | undefined;
    }
    visited.add(parent);
  }
  return undefined;
}
owningModule(world.component(Position)); // feature
world.scope(feature.entity, () => world.entity("another child"));
```

`world.module()` runs a new module's `init` inside `world.scope(mod.entity, ...)`. Nested modules
are children of the enclosing scope; their own creations belong to the nested module. Provenance is
the **nearest module ancestor**, not necessarily the direct parent: a `OneOf` value may be parented
to its relationship entity, which is parented to the module. This is a real ownership hierarchy:
ordinary parent destruction cascades through its children, and subtree traversal follows it.

Vecs' own built-in modules installed by the `World` constructor are **not scoped**; their entities
remain roots. Provenance covers modules installed after the world is constructed, including physics,
network, Phaser and application modules. Registration outside a scope leaves a root. Idempotent
re-registration keeps the existing parent: there is no list of duplicate registrars and no record of
which module added a trait edge. Explicit reparenting changes ownership, not a historical audit.

## Releasing resources

Release resources acquired in `init` with a `remove` hook on the module's entity. You do not need
a sentinel entity solely to observe world teardown (such as SpaceRocks' RadialMenu pattern).
For a class-owned recipe, declare a static hook:

```ts
import { type Entity, Module } from "@vworlds/vecs";

class RefreshModule extends Module {
  private timer?: ReturnType<typeof setInterval>;

  public init(): void {
    this.timer = setInterval(() => console.log("refresh"), 1000);
  }

  public static vecs_remove(_entity: Entity, mod: RefreshModule): void {
    clearInterval(mod.timer);
  }
}
```

Alternatively, register an instance hook inside `init`, for example
`this.entity.on("remove", () => clearInterval(this.timer))`, or register one on
`world.module(RefreshModule).entity`. The hook receives the definition entity and the module.
If you register both static and instance hooks, both run.

[`world.dispose()`](./entities.md#disposing-a-world) first settles application cleanup,
then removes module singleton values in reverse installation order: later siblings and nested
children precede their installing parents. Earlier modules' values, systems, queries and other
infrastructure singletons are still available to the hook. A throwing hook propagates out of
disposal and leaves the world partial. Repeated disposal does not run the hooks again.
Modules without hooks need no special handling.

Removing a module singleton manually is not a supported module-unloading API: it does not
define what should happen to entities created by that module.

## Built-in modules

Every `World` constructor installs these (`lib/vecs/src/world/world.ts`); you interact with their
_components_, not with the module objects:

| Module                | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityModule`      | The `Identity` name component and the name → entity index behind `world.entity("name")` / `entity.name`.                                                                                                                                                                                                                                                                                                                                                                   |
| `ImplementsModule`    | Marks `Implements` with `Trait` and maintains its [interface aliases](./components.md#interface-aliases-with-implements) and transitive closure.                                                                                                                                                                                                                                                                                                                           |
| `SingletonModule`     | Marks `Singleton` with `Trait` and enforces its [one-carrier constraint](./components.md#singletons-and-world-global-data).                                                                                                                                                                                                                                                                                                                                                |
| `RelationshipsModule` | Marks `Exclusive`, `Traversable`, `OwnedTarget`, `With`, `Requires`, `OneOf`, `OnDelete`, and `OnDeleteTarget` with `Trait`; configures built-in exclusivity, [companion removal](./components.md#component-traits-policy-on-component-entities), [owned targets](./relationships.md#owned-targets), [depth tracking](./relationships.md#traversal-order-traversable-and-cascade), and [cleanup policies](./components.md#cleanup-policies-destroying-a-component-entity). |
| `SnapshotModule`      | Marks `OnSnapshot` with `Trait`, registers its policy targets, and excludes world-bound types and local schema markers from [subtree snapshots](./snapshots.md).                                                                                                                                                                                                                                                                                                           |
| `PipelineModule`      | Creates the eight [built-in phases](./execution-model.md#phases-the-pipeline-spine) and installs the default pipeline query.                                                                                                                                                                                                                                                                                                                                               |

All are exported, so a custom world setup can reuse them.

## Reference

| API                                                                            | Description                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `class M extends Module<Config>`                                               | Declare a module; `Config` defaults to `undefined`.                                                         |
| `init(config)`                                                                 | One-time setup hook; called by the world on first registration.                                             |
| `world.module(M)` / `world.module(M, config)` / `world.module(M, config, eid)` | Install (first call) or retrieve (later calls) the module instance. Config after first registration throws. |
| `this.world`                                                                   | The owning world.                                                                                           |
| `this.entity`                                                                  | The module class's definition entity: scope parent and hook target, not gameplay data.                      |
| `world.scope(parent, fn)`                                                      | Parent all synchronous creations in `fn`; existing lookups are unchanged.                                   |
| `ModuleConfig<T>`                                                              | Utility type extracting a module's config type.                                                             |
| `ModuleClass<T>`                                                               | Constructor type `world.module` accepts: `new (world, entity) => T`.                                        |
| `ModuleDef`                                                                    | Tag on every installed module's definition entity; test with `entity.has(ModuleDef)`.                       |
