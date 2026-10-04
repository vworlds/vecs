// `snapshotSubtree` capture: walk the forest, then copy each entity's selected
// data into detached snapshot records. Nothing here mutates the source world.

import { Component } from "../component.js";
import { type ComponentMeta, type ComponentType, type Relationship } from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { type ResolvedSnapshotPolicy, _resolveSnapshotPolicy } from "../modules/snapshot_types.js";
import { ChildOf } from "../modules/relationship_types.js";
import { type World } from "../world/world.js";
import {
  type ComponentSnapshot,
  type EntitySubtreeSnapshot,
  type ExternalTargetPolicy,
  type RelationshipSnapshot,
  type ResolvedSnapshotOptions,
  type SubtreeEntitySnapshot,
  type SubtreeSnapshotOptions,
  _relationshipData,
} from "./types.js";

/** One entity of the captured forest, with the flag distinguishing roots. */
interface ForestMember {
  entity: Entity;
  root: boolean;
}

/**
 * @internal Capture `roots` and their transitive subtree.
 *
 * The whole forest is walked and copied before the caller is allowed to mutate
 * anything, so a capture that throws (cycle, duplicate membership, an excluded
 * type, an external target under the `"error"` policy) leaves the source world
 * untouched.
 *
 * @throws If a root is destroyed, is a component-definition entity, the
 *   traversal relationship is unregistered, the forest contains a cycle, an
 *   entity is reachable twice, a selected type is `DontSnapshot`, or an external
 *   target is found under the `"error"` policy.
 */
export function _captureSubtree(
  world: World,
  roots: Entity | readonly Entity[],
  options: SubtreeSnapshotOptions
): EntitySubtreeSnapshot {
  const resolved = _resolveOptions(world, options);
  const rootList = Array.isArray(roots) ? (roots as readonly Entity[]) : [roots as Entity];
  if (rootList.length === 0) {
    throw new Error("snapshotSubtree requires at least one root");
  }

  const forest = _collectForest(world, rootList, resolved);
  const records: SubtreeEntitySnapshot[] = [];
  for (const member of forest.values()) {
    records.push(_captureEntity(world, member.entity, member.root, forest, resolved));
  }

  return {
    entities: records,
    roots: rootList.map((root) => root.eid),
    traversal: resolved.traversal,
  };
}

/** @internal Resolve caller options against the source world. */
export function _resolveOptions(
  world: World,
  options: SubtreeSnapshotOptions
): ResolvedSnapshotOptions {
  const traversal = options.traversal ?? ChildOf;
  const traversalEid = _requireRegistered(world, traversal, "traversal");
  const externalTargets = options.externalTargets ?? "omit";
  if (externalTargets !== "omit" && externalTargets !== "error") {
    throw new Error(
      `snapshotSubtree: externalTargets must be "omit" or "error", received '${String(externalTargets)}'`
    );
  }
  return {
    traversal,
    traversalEid,
    components: _allowlist(world, options.components, "components"),
    relationships: _allowlist(world, options.relationships, "relationships"),
    externalTargets,
  };
}

/** @internal Walk each root depth-first, rejecting cycles and repeated members. */
function _collectForest(
  world: World,
  roots: readonly Entity[],
  resolved: ResolvedSnapshotOptions
): Map<EID, ForestMember> {
  const members = new Map<EID, ForestMember>();
  const onPath = new Set<EID>();
  const traversalName = resolved.traversal.name;

  for (const root of roots) {
    if (root.world !== world) {
      throw new Error("snapshotSubtree roots must belong to the source world");
    }
    if (root.destroyed) {
      throw new Error(`Cannot snapshot destroyed entity ${root.eid}`);
    }
    if (root instanceof Component) {
      throw new Error(
        `Cannot snapshot component entity ${root.eid}; snapshot ordinary entities only`
      );
    }
    if (members.has(root.eid)) {
      throw new Error(`snapshotSubtree: entity ${root.eid} is a member of the forest twice`);
    }
    members.set(root.eid, { entity: root, root: true });
    onPath.add(root.eid);

    const stack: { entity: Entity; pending: Entity[] }[] = [
      { entity: root, pending: childrenOf(root, resolved.traversalEid) },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const child = frame.pending.pop();
      if (child === undefined) {
        onPath.delete(frame.entity.eid);
        stack.pop();
        continue;
      }
      if (onPath.has(child.eid)) {
        throw new Error(
          `snapshotSubtree: ${traversalName} cycle reaches entity ${child.eid} from entity ${frame.entity.eid}`
        );
      }
      if (members.has(child.eid)) {
        throw new Error(`snapshotSubtree: entity ${child.eid} is a member of the forest twice`);
      }
      members.set(child.eid, { entity: child, root: false });
      onPath.add(child.eid);
      stack.push({ entity: child, pending: childrenOf(child, resolved.traversalEid) });
    }
  }

  return members;
}

/** @internal Copy one entity's selected components and edges into a record. */
function _captureEntity(
  world: World,
  entity: Entity,
  root: boolean,
  forest: Map<EID, ForestMember>,
  resolved: ResolvedSnapshotOptions
): SubtreeEntitySnapshot {
  const components: ComponentSnapshot[] = [];
  const relationships: RelationshipSnapshot[] = [];

  entity.components.forEach((instance, ceid) => {
    const meta = _capturableMeta(world, ceid);
    if (meta === undefined) {
      return;
    }
    const policy = _policyFor(world, meta, entity, resolved);
    if (policy === undefined) {
      return;
    }
    if (meta.isRelationship) {
      if (resolved.relationships !== undefined && !resolved.relationships.has(ceid)) {
        return;
      }
      relationships.push(
        _captureRelationship(
          meta,
          entity,
          instance as Relationship,
          policy,
          forest,
          resolved.externalTargets
        )
      );
      return;
    }
    if (resolved.components !== undefined && !resolved.components.has(ceid)) {
      return;
    }
    components.push({ Class: meta.Class, data: _captureData(policy, instance) });
  });

  return { key: entity.eid, source: entity, root, components, relationships };
}

/**
 * The inheritance relationship that vecs' open inheritance work (#184-#188)
 * introduces. It does not exist yet, so it is matched by name; swap this for an
 * identity check against the real class when that work lands.
 *
 * A subtree snapshot must never carry an inheritance edge: the edge and the
 * values it materialized would both be captured, and the destination would then
 * hold two disagreeing answers. Callers that want to move an inheriting entity
 * flatten its effective values instead.
 */
const INHERITANCE_RELATIONSHIP = "IsA";

/** @internal Copy one relationship's non-edge data and its kept edges. */
function _captureRelationship(
  meta: ComponentMeta,
  entity: Entity,
  relationship: Relationship,
  policy: ResolvedSnapshotPolicy,
  forest: Map<EID, ForestMember>,
  externalTargets: ExternalTargetPolicy
): RelationshipSnapshot {
  if (meta.Class.name === INHERITANCE_RELATIONSHIP) {
    throw new Error(
      `snapshotSubtree: ${INHERITANCE_RELATIONSHIP} inheritance edges cannot be captured; flatten the inheriting entity's effective values instead`
    );
  }
  const targets: EID[] = [];
  let dropped = 0;
  for (const target of relationship._targetArray()) {
    if (forest.has(target.eid)) {
      targets.push(target.eid);
      continue;
    }
    if (externalTargets === "error") {
      throw new Error(
        `snapshotSubtree: ${meta.Class.name} on entity ${entity.eid} targets entity ${target.eid}, which is outside the captured subtree`
      );
    }
    dropped++;
  }
  return {
    Class: meta.Class as RelationshipSnapshot["Class"],
    data: policy.kind === "custom" ? policy.capture(relationship) : _relationshipData(relationship),
    targets,
    externalTargets: dropped,
  };
}

/** @internal Resolve the capture policy, or `undefined` to skip the type. */
function _policyFor(
  world: World,
  meta: ComponentMeta,
  entity: Entity,
  resolved: ResolvedSnapshotOptions
): ResolvedSnapshotPolicy | undefined {
  const policy = _resolveSnapshotPolicy(world, meta);
  if (policy.kind !== "none") {
    return policy;
  }
  const allowlist = meta.isRelationship ? resolved.relationships : resolved.components;
  if (allowlist?.has(meta.eid)) {
    throw new Error(
      `snapshotSubtree: ${meta.Class.name} is declared DontSnapshot but was selected on entity ${entity.eid}`
    );
  }
  return undefined;
}

/** @internal Run one policy over one instance. */
function _captureData(policy: ResolvedSnapshotPolicy, instance: object): unknown {
  if (policy.kind === "custom") {
    return policy.capture(instance);
  }
  return { ...instance };
}

/**
 * @internal Metadata for a component slot that can be captured, or `undefined`
 * for slots that carry no transferable data of their own: interface aliases
 * (the concrete type is captured once) and entity-as-component-key slots
 * (class `Object`, an empty placeholder).
 */
function _capturableMeta(world: World, ceid: EID): ComponentMeta | undefined {
  const component = world.getEntity(ceid);
  if (component === undefined) {
    return undefined;
  }
  const meta = component.meta;
  if (meta._isInterface || meta.Class === Object) {
    return undefined;
  }
  return meta;
}

/** @internal Return one entity's children through `relEid` as a mutable list. */
function childrenOf(entity: Entity, relEid: EID): Entity[] {
  return [...(entity._childrenByEid(relEid) ?? [])];
}

/** @internal Resolve a component class to its id, rejecting unregistered types. */
function _requireRegistered(world: World, Class: ComponentType, label: string): EID {
  const component = world._classRegistry.get(Class);
  if (component === undefined) {
    throw new Error(`snapshotSubtree: ${label} class '${Class.name}' is not registered`);
  }
  return component.eid;
}

/** @internal Turn an allowlist into a set of component ids, or `undefined` for "all". */
function _allowlist(
  world: World,
  classes: readonly ComponentType[] | undefined,
  label: string
): Set<EID> | undefined {
  if (classes === undefined) {
    return undefined;
  }
  const ids = new Set<EID>();
  for (const Class of classes) {
    ids.add(_requireRegistered(world, Class, label));
  }
  return ids;
}
