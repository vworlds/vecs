// Public data shapes for cross-world subtree snapshots. The capture, preflight,
// and restore implementations live in `capture.ts`, `preflight.ts`, and
// `restore.ts`; `materialize.ts` holds the one component materializer that both
// ordinary `set` and restore go through.

import {
  type ComponentInstance,
  type ComponentType,
  type Relationship,
} from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { type SnapshotMaterialize } from "../modules/snapshot_types.js";

/** A relationship component class. */
export type RelationshipType = ComponentType<Relationship>;

/**
 * What to do with a captured relationship edge whose target is **outside** the
 * captured subtree.
 *
 * - `"omit"` (default) — drop the edge. The destination entity keeps the
 *   relationship's other targets and its non-edge data.
 * - `"error"` — fail the capture. Use it when a partial forest would be a
 *   silent gameplay bug.
 */
export type ExternalTargetPolicy = "omit" | "error";

/** Caller-controlled selection and traversal for {@link World.snapshotSubtree}. */
export interface SubtreeSnapshotOptions {
  /**
   * Relationship traversed from each root to collect the subtree. Defaults to
   * {@link ChildOf}. Must be registered in the source world.
   */
  traversal?: RelationshipType;
  /**
   * Component classes to capture. When omitted, every captured component type
   * participates — the caller selects what moves by narrowing this list.
   *
   * Naming a type whose {@link OnSnapshot} policy is `DontSnapshot` is a
   * preflight error, never a silent omission.
   */
  components?: readonly ComponentType[];
  /**
   * Relationship classes whose edges to capture. When omitted, every captured
   * relationship participates. The `traversal` relationship is captured only if
   * it is named here.
   */
  relationships?: readonly RelationshipType[];
  /**
   * How to treat relationship targets outside the captured subtree. Defaults
   * to `"omit"`.
   */
  externalTargets?: ExternalTargetPolicy;
}

/** One captured component: its class, its detached data, and how to rebuild it. */
export interface ComponentSnapshot {
  /** Component class, as registered in the source world. */
  readonly Class: ComponentType;
  /**
   * Payload produced by the type's capture policy. Never references the source
   * world.
   */
  readonly data: unknown;
  /**
   * The materializer the source world's policy resolved to **at capture time**.
   *
   * Binding it here is what makes a snapshot stable: a policy declared, changed,
   * or revoked after the capture cannot change how this snapshot restores.
   */
  readonly materialize: SnapshotMaterialize;
}

/**
 * One captured relationship: its class, its non-edge data, and the edges it
 * keeps.
 *
 * Edge data is stored separately from the relationship payload because targets
 * are world-local entity references: restore rebuilds each edge through the
 * public relationship API and remaps internal targets onto freshly allocated
 * destination ids.
 */
export interface RelationshipSnapshot {
  /** Relationship class, as registered in the source world. */
  readonly Class: RelationshipType;
  /** Payload for the relationship's own fields, excluding target storage. */
  readonly data: unknown;
  /** Snapshot keys of the targets inside the captured subtree, in edge order. */
  readonly targets: readonly EID[];
  /**
   * How many targets were left behind because they sit outside the captured
   * subtree. Always `0` under the `"error"` external-target policy.
   */
  readonly externalTargets: number;
  /**
   * The materializer the source world's policy resolved to at capture time, for
   * a relationship that declares a custom policy. `undefined` for the default
   * {@link ClonePublic}, where edges create the instance and the payload is
   * assigned through the ordinary relationship path.
   */
  readonly materialize: SnapshotMaterialize | undefined;
}

/** One captured entity: its identity, its position in the forest, and its data. */
export interface SubtreeEntitySnapshot {
  /**
   * Snapshot key: the source entity's id at capture time. Stable for the life of
   * the snapshot and unique within it.
   */
  readonly key: EID;
  /** The source entity. A snapshot stays bound to the world it was captured in. */
  readonly source: Entity;
  /** `true` for an explicitly requested root, `false` for a traversed member. */
  readonly root: boolean;
  /** Captured plain-data components, in ascending component-id order. */
  readonly components: readonly ComponentSnapshot[];
  /** Captured relationships, in ascending component-id order. */
  readonly relationships: readonly RelationshipSnapshot[];
}

/**
 * Detached, world-agnostic capture of one root or an atomic forest.
 *
 * Produced by {@link World.snapshotSubtree} before any mutation, consumed by
 * {@link World.restoreSubtree} and {@link World.moveSubtree}. Holding a
 * snapshot does not reserve anything and does not keep the source entities
 * alive — restore always allocates fresh destination ids.
 */
export interface EntitySubtreeSnapshot {
  /** Captured records in depth-first order, roots first. */
  readonly entities: readonly SubtreeEntitySnapshot[];
  /** Snapshot keys of the requested roots, in the order they were given. */
  readonly roots: readonly EID[];
  /** The relationship traversed during capture. */
  readonly traversal: RelationshipType;
}

/** What {@link World.restoreSubtree} and {@link World.moveSubtree} return. */
export interface RestoreSubtreeResult {
  /** Snapshot key to the destination entity created for that record. */
  readonly entities: ReadonlyMap<EID, Entity>;
  /** Source entity to the destination entity that replaced it. */
  readonly sourceToDestination: ReadonlyMap<Entity, Entity>;
  /** The destination entities for the requested roots, in order. */
  readonly roots: readonly Entity[];
}

/**
 * What {@link World.moveSubtree} returns. Identical to
 * {@link RestoreSubtreeResult}; named separately because the source entities no
 * longer exist when it resolves.
 */
export type MoveSubtreeResult = RestoreSubtreeResult;

/** @internal The allowlists and traversal resolved against one source world. */
export interface ResolvedSnapshotOptions {
  traversal: RelationshipType;
  traversalEid: EID;
  components: Set<EID> | undefined;
  relationships: Set<EID> | undefined;
  externalTargets: ExternalTargetPolicy;
}

/**
 * @internal Capture a relationship instance's own data fields; symbol-keyed target
 * storage is not among `Object.keys`.
 *
 * Ownership and cleanup decisions live in the snapshot, not in the transfer.
 * Destroying a source root can cascade through a `CleanupPolicy.Delete` edge to
 * an entity the caller did not select, and that is the correct reading of "the
 * source is gone" rather than a leak — which is why the reverse direction holds
 * too: an edge pointing *into* the subtree from outside is never carried across,
 * by a successful move or by a rollback. Inbound state belongs to whatever world
 * the outside entity still lives in.
 */
export function _relationshipData(instance: Relationship): ComponentInstance {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(instance)) {
    data[key] = (instance as unknown as Record<string, unknown>)[key];
  }
  return data;
}
