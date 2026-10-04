// Destination-side validation for a captured snapshot. Runs before the first
// destination entity exists, so a snapshot that cannot be restored fails without
// leaving anything behind.

import { type ComponentMeta, type ComponentType } from "../component_meta.js";
import { _resolveSnapshotPolicy } from "../modules/snapshot_types.js";
import { type World } from "../world/world.js";
import { type EntitySubtreeSnapshot } from "./types.js";

/**
 * @internal Assert that every class the snapshot needs is usable in
 * `destination`, and return the destination metadata for each captured class.
 *
 * Entity ids, component ids, and relationship edges are world-local, so a
 * snapshot can only be restored into a world that registered the same component
 * classes with a capture policy that still admits them. A missing or excluded
 * class is a module-composition mistake, and it must surface before anything is
 * created — otherwise a partial forest would have to be built and torn down.
 *
 * @throws If any captured class is unregistered in `destination`, or its
 *   destination policy excludes it.
 */
export function _preflightRestore(destination: World, snapshot: EntitySubtreeSnapshot): void {
  for (const record of snapshot.entities) {
    for (const captured of record.components) {
      _requireUsable(destination, captured.Class, record.key);
    }
    for (const captured of record.relationships) {
      _requireUsable(destination, captured.Class, record.key);
    }
  }
}

/** @internal Assert one captured class is registered and not excluded in `world`. */
export function _requireUsable(world: World, Class: ComponentType, key: number): ComponentMeta {
  const component = world._classRegistry.get(Class);
  if (component === undefined) {
    throw new Error(
      `restoreSubtree: component class '${Class.name}' captured for entity ${key} is not registered in the destination world`
    );
  }
  const meta = component.meta;
  if (_resolveSnapshotPolicy(world, meta).kind === "none") {
    throw new Error(
      `restoreSubtree: component class '${Class.name}' captured for entity ${key} is declared DontSnapshot in the destination world`
    );
  }
  return meta;
}
