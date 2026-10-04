// Cross-world subtree snapshot, restore, and move.
//
// The three operations are a matched set:
//
// - `capture` copies a root or an atomic forest into detached records,
// - `restore` recreates those records in another world through vecs' own
//   component and relationship APIs,
// - `move` is capture → preflight → destroy the source → restore, with a
//   rollback that restores the source snapshot when the destination restore
//   fails.
//
// `materialize` is not a separate file: the canonical component materializer is
// `Entity._materialize` (`lib/vecs/src/entity/entity.components.ts`), which
// ordinary `set` and restore both go through.

export { _captureSubtree, _resolveOptions } from "./capture.js";
export { _preflightRestore, _requireUsable } from "./preflight.js";
export { _restoreSubtree } from "./restore.js";
export {
  _relationshipData,
  type ComponentSnapshot,
  type EntitySubtreeSnapshot,
  type ExternalTargetPolicy,
  type MoveSubtreeResult,
  type RelationshipSnapshot,
  type RelationshipType,
  type ResolvedSnapshotOptions,
  type RestoreSubtreeResult,
  type SubtreeEntitySnapshot,
  type SubtreeSnapshotOptions,
} from "./types.js";
