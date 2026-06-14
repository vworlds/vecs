import { cpus } from "node:os";

import Box2DFactory from "box2d3-wasm";

import type { b2AABB, b2QueryFilter, b2Vec2 } from "./engine.js";

export type Box2DModule = Awaited<ReturnType<typeof Box2DFactory>>;

let modulePromise: Promise<Box2DModule> | null = null;
let module: Box2DModule | null = null;

// Global scratch pools for common Box2D structs. Allocated once at module load,
// reused across queries and other non-reentrant operations.
export const scr_b2Vec2: b2Vec2[] = [];
export const scr_b2QueryFilter: b2QueryFilter[] = [];
export let scr_b2AABB: b2AABB | null = null;

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
    initializeScratchPools(loadedModule);
    return loadedModule;
  });
  await modulePromise;
}

function initializeScratchPools(box2d: Box2DModule): void {
  // b2Vec2: ray casts need 2 simultaneous (origin + translation), polygon/chain creation
  // can reuse serially. Allocate 3 for safety margin.
  for (let i = 0; i < 3; i++) {
    scr_b2Vec2.push(new box2d.b2Vec2());
  }

  // b2QueryFilter: queries and material_filter_sync each need at most 1 simultaneously.
  // Allocate 2 for safety.
  for (let i = 0; i < 2; i++) {
    scr_b2QueryFilter.push(new box2d.b2QueryFilter());
  }

  // b2AABB: overlapAABB needs exactly 1.
  scr_b2AABB = new box2d.b2AABB();
}

export function getBox2D(): Box2DModule {
  if (!module) {
    throw new Error(
      "Box2D module not loaded. Call `await preloadPhysics()` before `world.module(PhysicsModule)`."
    );
  }
  return module;
}
