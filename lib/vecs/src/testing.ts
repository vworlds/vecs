import { Entity } from "./entity/index.js";
import { World } from "./world/index.js";

/**
 * Compare entities and worlds by reference, preventing deep traversal of ECS data.
 * Register once with Vitest's `expect.addEqualityTesters([vecsEqualityTester])`.
 * Returns `a === b` if either value is an Entity or World (including subclasses),
 * otherwise `undefined` to preserve the framework's normal equality behavior.
 * This module has no runtime dependency on Vitest.
 */
export function vecsEqualityTester(a: unknown, b: unknown): boolean | undefined {
  if (a instanceof Entity || b instanceof Entity || a instanceof World || b instanceof World) {
    return a === b;
  }
  return undefined;
}
