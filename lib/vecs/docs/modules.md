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

## Built-in modules

Every `World` constructor installs these (`lib/vecs/src/world/world.ts`); you interact with their
_components_, not with the module objects:

| Module                | Provides                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityModule`      | The `Identity` name component and the name → entity index behind `world.entity("name")` / `entity.name`.                                                                                                                                                                                       |
| `ImplementsModule`    | Maintains [`Implements` interface aliases](./components.md#interface-aliases-with-implements) and their transitive closure.                                                                                                                                                                    |
| `SingletonModule`     | Enforces the [`Singleton`](./components.md#singletons-and-world-global-data) one-carrier constraint.                                                                                                                                                                                           |
| `RelationshipsModule` | Registers relationship traits, marks built-in single-target relationships `Exclusive`, installs explicit-edge [`OwnedTarget`](./relationships.md#owned-targets) ownership, and maintains exclusive [`Traversable` depth tracking](./relationships.md#traversal-order-traversable-and-cascade). |
| `InheritanceModule`   | Implements [one-shot `IsA` inheritance](./inheritance.md): add-time snapshots, per-component policy, and narrow `set` copy-on-write.                                                                                                                                                           |
| `PipelineModule`      | Creates the eight [built-in phases](./execution-model.md#phases-the-pipeline-spine) and installs the default pipeline query.                                                                                                                                                                   |

All are exported, so a custom world setup can reuse them.

## Reference

| API                                                                            | Description                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `class M extends Module<Config>`                                               | Declare a module; `Config` defaults to `undefined`.                                                 |
| `init(config)`                                                                 | One-time setup hook; called by the world on first registration.                                     |
| `world.module(M)` / `world.module(M, config)` / `world.module(M, config, eid)` | Register (first call) or retrieve (later calls) the module. Config after first registration throws. |
| `this.world`                                                                   | Inside `init`: the owning world (a module is an entity).                                            |
| `ModuleConfig<T>`                                                              | Utility type extracting a module's config type.                                                     |
