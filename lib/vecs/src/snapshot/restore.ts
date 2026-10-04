// The destination side of a subtree transfer: allocate fresh ids, then rebuild
// every component and edge through vecs' own APIs so ownership, aliases,
// exclusivity, hooks, and query routing happen exactly once per component.
//
// Nothing in this file touches the source world's entities beyond reading the
// snapshot records; entity ids and relationship edges cannot be transplanted,
// only recreated.

import { type EID, type Entity } from "../entity/index.js";
import { _resolveSnapshotPolicy } from "../modules/snapshot_types.js";
import { type World } from "../world/world.js";
import { _preflightRestore, _requireUsable } from "./preflight.js";
import { type EntitySubtreeSnapshot, type RestoreSubtreeResult } from "./types.js";

/**
 * @internal Recreate a captured snapshot inside `destination`.
 *
 * Order matters and is fixed:
 *
 * 1. Preflight every class against the destination's registry and policies.
 * 2. Allocate one destination entity per record, so every edge target exists
 *    before any edge is added.
 * 3. Materialize plain-data components through the canonical materializer.
 * 4. Rebuild the traversal relationship's edges, then every other edge, so
 *    hierarchy-sensitive policies (`OneOf`, `Traversable`) see a complete tree.
 * 5. Assign each relationship's non-edge data, in capture order.
 *
 * Any throw in steps 2–5 destroys everything this attempt created and
 * rethrows, so a failed restore leaves the destination as it was found.
 *
 * @throws If a class is unusable in `destination`, an edge target is missing
 *   from the snapshot, or materialization fails.
 */
export function _restoreSubtree(
  destination: World,
  snapshot: EntitySubtreeSnapshot
): RestoreSubtreeResult {
  const entities = new Map<EID, Entity>();
  const sourceToDestination = new Map<Entity, Entity>();
  const created: Entity[] = [];

  try {
    _preflightRestore(destination, snapshot);

    for (const record of snapshot.entities) {
      const entity = destination.entity();
      entities.set(record.key, entity);
      sourceToDestination.set(record.source, entity);
      created.push(entity);
    }

    for (const record of snapshot.entities) {
      const entity = entities.get(record.key)!;
      for (const captured of record.components) {
        const meta = _requireUsable(destination, captured.Class, record.key);
        // A custom policy owns construction; otherwise the canonical
        // `new Class()` plus field assignment in `Entity._materialize` runs.
        const policy = _resolveSnapshotPolicy(destination, meta);
        entity._materialize(
          meta,
          captured.data,
          policy.kind === "custom" ? policy.materialize : undefined
        );
      }
    }

    _rebuildEdges(destination, snapshot, entities, true);
    _rebuildEdges(destination, snapshot, entities, false);

    for (const record of snapshot.entities) {
      const entity = entities.get(record.key)!;
      for (const captured of record.relationships) {
        if (captured.data != null) {
          entity._set(_requireUsable(destination, captured.Class, record.key), captured.data);
        }
      }
    }
  } catch (error) {
    for (let i = created.length - 1; i >= 0; i--) {
      if (!created[i].destroyed) {
        created[i].destroy();
      }
    }
    throw error;
  }

  return {
    entities,
    sourceToDestination,
    roots: snapshot.roots.map((key) => entities.get(key)!),
  };
}

/**
 * @internal Rebuild one pass of relationship edges.
 *
 * `hierarchy` selects the traversal relationship, which is rebuilt first so that
 * parent-sensitive policies see a complete hierarchy before any other edge lands.
 */
function _rebuildEdges(
  destination: World,
  snapshot: EntitySubtreeSnapshot,
  entities: Map<EID, Entity>,
  hierarchy: boolean
): void {
  for (const record of snapshot.entities) {
    const source = entities.get(record.key)!;
    for (const captured of record.relationships) {
      if ((captured.Class === snapshot.traversal) !== hierarchy) {
        continue;
      }
      const meta = _requireUsable(destination, captured.Class, record.key);
      for (const key of captured.targets) {
        const target = entities.get(key);
        if (target === undefined) {
          throw new Error(
            `restoreSubtree: ${captured.Class.name} on entity ${record.key} targets snapshot key ${key}, which is not part of the snapshot`
          );
        }
        source._addTarget(meta, target);
      }
    }
  }
}
