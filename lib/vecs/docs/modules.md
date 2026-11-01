# Modules

Package components, systems, and policy into reusable units, compose them, and meet the built-in
modules every world installs.

## What a module is

A `Module` (`lib/vecs/src/module.ts`) is a component entity whose `init()` method runs once when
the module is registered. It is the unit of packaging for a feature: registering components,
declaring systems, setting exclusivity and cleanup policy, and (rarely) inserting phases.

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

`world.module(ModuleClass, config?, eid?)` (`lib/vecs/src/world/world.modules.ts`) registers the
module on first call — drawing its entity id from the `module` pool (900–999 by default, or pass
an explicit `eid`) — and invokes `init(config)` exactly once. Subsequent calls return the existing
module instance; passing a config again after the first registration throws.
Install new modules outside `progress()` and `defer`; installation also throws during a command
drain, before registering anything. Looking up an already installed module works in any of those
contexts. Lazy loading from a system or hook is the application's job: schedule it after
`progress()` returns.

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
import { Entity, Module, World } from "@vworlds/vecs";

class Position {}
class Feature extends Module {
  public init(): void {
    this.world.component(Position);
    this.world.entity("camera");
  }
}
const world = new World();
const feature = world.module(Feature);
world.component(Position).parent === feature; // true
world.entity("camera").parent === feature; // true

function owningModule(entity: Entity): Module | undefined {
  const visited = new Set<Entity>();
  for (let parent = entity.parent; parent && !visited.has(parent); parent = parent.parent) {
    if (parent instanceof Module) return parent;
    visited.add(parent);
  }
  return undefined;
}
owningModule(world.component(Position)); // feature
world.scope(feature, () => world.entity("another child"));
```

`world.module()` runs a new module's `init` inside `world.scope(moduleEntity, ...)`. Nested modules
are children of the enclosing scope; their own creations belong to the nested module. Provenance is
the **nearest module ancestor**, not necessarily the direct parent: a `OneOf` value may be parented
to its relationship entity, which is parented to the module. This is a real ownership hierarchy:
ordinary parent destruction cascades through its children, and subtree traversal follows it.

Vecs' own built-in modules installed by the `World` constructor are **not scoped**; their entities
remain roots. Provenance covers modules installed after the world is constructed, including physics,
network, Phaser and application modules. Registration outside a scope leaves a root. Idempotent
re-registration keeps the existing parent: there is no list of duplicate registrars and no record of
which module added a trait edge. Explicit reparenting changes ownership, not a historical audit.

## Built-in modules

Every `World` constructor installs these (`lib/vecs/src/world/world.ts`); you interact with their
_components_, not with the module objects:

| Module                | Provides                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityModule`      | The `Identity` name component and the name → entity index behind `world.entity("name")` / `entity.name`.                                                                                                                                                                                                                                                 |
| `ImplementsModule`    | Marks `Implements` with `Trait` and maintains its [interface aliases](./components.md#interface-aliases-with-implements) and transitive closure.                                                                                                                                                                                                         |
| `SingletonModule`     | Marks `Singleton` with `Trait` and enforces its [one-carrier constraint](./components.md#singletons-and-world-global-data).                                                                                                                                                                                                                              |
| `RelationshipsModule` | Marks `Exclusive`, `Traversable`, `OwnedTarget`, `With`, `Requires`, and `OneOf` with `Trait`; configures built-in exclusivity, [companion removal](./components.md#component-traits-policy-on-component-entities), [owned targets](./relationships.md#owned-targets), and [depth tracking](./relationships.md#traversal-order-traversable-and-cascade). |
| `SnapshotModule`      | Marks `OnSnapshot` with `Trait`, registers its policy targets, and excludes world-bound types and local schema markers from [subtree snapshots](./snapshots.md).                                                                                                                                                                                         |
| `PipelineModule`      | Creates the eight [built-in phases](./execution-model.md#phases-the-pipeline-spine) and installs the default pipeline query.                                                                                                                                                                                                                             |

All are exported, so a custom world setup can reuse them.

## Reference

| API                                                                            | Description                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `class M extends Module<Config>`                                               | Declare a module; `Config` defaults to `undefined`.                                                 |
| `init(config)`                                                                 | One-time setup hook; called by the world on first registration.                                     |
| `world.module(M)` / `world.module(M, config)` / `world.module(M, config, eid)` | Register (first call) or retrieve (later calls) the module. Config after first registration throws. |
| `this.world`                                                                   | Inside `init`: the owning world (a module is an entity).                                            |
| `world.scope(parent, fn)`                                                      | Parent all synchronous creations in `fn`; existing lookups are unchanged.                           |
| `ModuleConfig<T>`                                                              | Utility type extracting a module's config type.                                                     |
