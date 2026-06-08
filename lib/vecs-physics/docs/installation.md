# Installation

Install `vecs`, `vecs-physics`, and then preload the physics runtime before installing physics into a world.

```sh
npm install @vworlds/vecs @vworlds/vecs-physics
```

`@vworlds/vecs-physics` depends on `box2d3-wasm` as a transitive runtime dependency. Application code does not import `box2d3-wasm` directly; call `preloadPhysics()` from `@vworlds/vecs-physics` and let the adapter own the Box2D module.

## Bootstrap

```ts
import { World } from "@vworlds/vecs";
import { installPhysics, preloadPhysics } from "@vworlds/vecs-physics";

await preloadPhysics();

const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

`preloadPhysics()` is async and cached. Call it once before the first `installPhysics()` in a process. `installPhysics()` stays synchronous so world setup and phase wiring remain deterministic after the WASM module has loaded.

If `installPhysics()` runs before `preloadPhysics()` resolves, it throws with a message telling you to call `await preloadPhysics()` first.

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
