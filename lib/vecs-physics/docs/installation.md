# Installation

Install `vecs`, `vecs-physics`, and then preload the physics runtime before registering the physics module in a world.

```sh
npm install @vworlds/vecs @vworlds/vecs-physics
```

`@vworlds/vecs-physics` depends on `box2d3-wasm` as a transitive runtime dependency. Application code does not import `box2d3-wasm` directly; call `preloadPhysics()` from `@vworlds/vecs-physics` and let the adapter own the Box2D module.

## Bootstrap

```ts
import { World } from "@vworlds/vecs";
import { PhysicsModule, preloadPhysics } from "@vworlds/vecs-physics";

await preloadPhysics();

const world = new World();

world.module(PhysicsModule, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

`preloadPhysics()` is async and cached. Call it once before the first `world.module(PhysicsModule)` in a process. Module registration stays synchronous so world setup and phase wiring remain deterministic after the WASM module has loaded.

If `world.module(PhysicsModule)` runs before `preloadPhysics()` resolves, it throws with a message telling you to call `await preloadPhysics()` first.

## Install The Module Before Creating Physics Entities

`world.module(PhysicsModule)` is what _registers_ the physics components (`Body`, `Box`, `Position`, …) on the world. Register the module before you add any of those components to entities — the same way you install an operating system before running programs on it.

```ts
await preloadPhysics();

const world = new World();
world.module(PhysicsModule); // registers the physics components and systems

// Now it is safe to create physics entities.
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });
world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });
```

Adding a physics component to an entity before the module is installed throws — the component class is not registered on the world yet:

```ts
const world = new World();
world.entity().set(Body, { type: BodyType.Dynamic });
// throws: unregistered component entity for component class 'Body'
```

There is no backfill of entities that somehow pre-date installation (for example, if you register the component classes yourself and create entities before `world.module(PhysicsModule)`): physics wires entities through its reactive systems, which only see components added on or after install. Install first, then build your world.

## Node Runtime Note

`box2d3-wasm` reads `navigator.hardwareConcurrency` during module initialization. Node does not always provide that browser global, so `preloadPhysics()` creates `globalThis.navigator` when needed and fills `navigator.hardwareConcurrency` from `node:os` CPU count.

The polyfill is guarded with `??=`. If your environment already provides `navigator.hardwareConcurrency`, `vecs-physics` leaves it alone.

## Browser Runtime Note

Version 1 uses the single-threaded `compat` build path. It does not require `crossOriginIsolated`.

`box2d3-wasm` also has a threaded `deluxe` build path. Browser pages that opt into that path need the usual cross-origin isolation headers so `SharedArrayBuffer` can be used:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

That threaded path is not part of the v1 `vecs-physics` public API. Treat it as an environment detail of the upstream WASM package.

## Related Pages

- [Getting Started](./getting-started.md)
- [Systems And Phases](./systems-and-phases.md)
