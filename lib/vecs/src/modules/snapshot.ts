// `SnapshotModule` installs the `OnSnapshot` trait's runtime invariants. The
// trait, its policy values, and the declaration helpers live in
// `snapshot_types.ts`, which is dependency-light on purpose: `component.ts`
// imports it, so it must not reach back through `module.ts`.

import { Module } from "../module.js";
import { Query } from "../query/index.js";
import { System } from "../system.js";
import { type World } from "../world/world.js";
import { Exclusive, OneOf } from "./relationship_types.js";
import { ClonePublic, CustomSnapshot, DontSnapshot, OnSnapshot } from "./snapshot_types.js";

export {
  type ResolvedSnapshotPolicy,
  type SnapshotCapture,
  type SnapshotMaterialize,
  type SnapshotPolicyType,
  ClonePublic,
  CustomSnapshot,
  DontSnapshot,
  OnSnapshot,
  _declareSnapshotPolicy,
  _resolveSnapshotPolicy,
} from "./snapshot_types.js";

/**
 * Built-in world module that registers the `OnSnapshot` trait and its policy
 * values.
 *
 * Registered automatically by every {@link World}. `OnSnapshot` is an
 * `Exclusive` pair-form trait restricted with {@link OneOf} to its own policy
 * children, so a component entity always names exactly one policy:
 * {@link ClonePublic} (the default), {@link DontSnapshot}, or
 * {@link CustomSnapshot}.
 *
 * The module installs the invariant that makes a snapshot trustworthy: a policy
 * is declared by the module that owns the component type, before any entity
 * carries that type. Declaring — or revoking — a policy while the component has
 * carriers throws, because entities already captured under the old policy would
 * restore under a different one.
 *
 * It also marks vecs' own world-bound component types {@link DontSnapshot}: a
 * live {@link Query} or {@link System} owns live membership, pending events, and
 * pipeline slots, so it can never be reconstructed in another world.
 */
export class SnapshotModule extends Module {
  public init(): void {
    const world = this.world;
    const onSnapshot = world.component(OnSnapshot);

    world.component(ClonePublic).childOf(onSnapshot);
    world.component(DontSnapshot).childOf(onSnapshot);
    world.component(CustomSnapshot).childOf(onSnapshot);

    onSnapshot.add(OneOf, onSnapshot);
    onSnapshot.add(Exclusive);

    onSnapshot.meta.on("targetPolicyAdd", (component) => {
      const meta = component.meta;
      if (meta.usageCount > 0) {
        throw new Error(
          `OnSnapshot policy for ${meta.Class.name} must be declared before the component has carriers`
        );
      }
    });
    onSnapshot.meta.on("targetPolicyRemove", (component, _rel, policy) => {
      if (component.destroyed || policy.destroyed) {
        return;
      }
      if (component.meta.usageCount > 0) {
        throw new Error(
          `OnSnapshot policy for ${component.meta.Class.name} cannot be removed or changed while the component has carriers`
        );
      }
    });

    world.component(Query).snapshotPolicy(DontSnapshot);
    world.component(System).snapshotPolicy(DontSnapshot);
  }
}
