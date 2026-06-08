import { cpus } from "node:os";

import Box2DFactory from "box2d3-wasm";

export type Box2DModule = Awaited<ReturnType<typeof Box2DFactory>>;

let modulePromise: Promise<Box2DModule> | null = null;
let module: Box2DModule | null = null;

export async function preloadPhysics(): Promise<void> {
  if (modulePromise) {
    await modulePromise;
    return;
  }

  // box2d3-wasm reads navigator.hardwareConcurrency during Node initialization.
  const global = globalThis as unknown as { navigator?: Partial<Navigator> };
  global.navigator ??= {};
  (global.navigator as { hardwareConcurrency?: number }).hardwareConcurrency ??= cpus().length;

  modulePromise = Box2DFactory().then((loadedModule) => {
    module = loadedModule;
    return loadedModule;
  });
  await modulePromise;
}

export function getBox2D(): Box2DModule {
  if (!module) {
    throw new Error(
      "Box2D module not loaded. Call `await preloadPhysics()` before `world.module(PhysicsModule)`."
    );
  }
  return module;
}
