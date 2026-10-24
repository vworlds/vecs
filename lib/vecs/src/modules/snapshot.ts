// `SnapshotModule` installs the `OnSnapshot` trait's runtime invariants. The
// trait, its policy values, and the declaration helpers live in
// `snapshot_types.ts`, which is dependency-light on purpose: `component.ts`
// imports it, so it must not reach back through `module.ts`.

import { Module } from "../module.js";
import { ComponentDef, Trait } from "../component_def.js";
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
 * Declares `OnSnapshot` as a {@link Trait}; policy values remain unmarked.
 *
 * Registered automatically by every {@link World}. `OnSnapshot` is an
 * `Exclusive` pair-form trait restricted with {@link OneOf} to its own policy
 * children, so a component entity always names exactly one policy:
 * {@link ClonePublic} (the default), {@link DontSnapshot}, or
 * {@link CustomSnapshot}.
 *
 * A policy may be declared, changed, or revoked at any time. It does not have to
 * precede the component's first carrier, because a capture *binds* the
 * materializer it resolved: {@link World.snapshotSubtree} stores that function
 * in each record, so a snapshot always restores the way it was captured and a
 * later policy declaration cannot retroactively change one.
 *
 * The module also marks vecs' own world-bound component types
 * {@link DontSnapshot}: a
 * live {@link Query} or {@link System} owns live membership, pending events, and
 * pipeline slots, so it can never be reconstructed in another world.
 */
export class SnapshotModule extends Module {
  public init(): void {
    const world = this.world;
    const onSnapshot = world.component(OnSnapshot).add(Trait);

    world.component(ClonePublic).childOf(onSnapshot);
    world.component(DontSnapshot).childOf(onSnapshot);
    world.component(CustomSnapshot).childOf(onSnapshot);

    onSnapshot.add(OneOf, onSnapshot);
    onSnapshot.add(Exclusive);

    world.component(Query).snapshotPolicy(DontSnapshot);
    world.component(System).snapshotPolicy(DontSnapshot);
    world.component(ComponentDef).snapshotPolicy(DontSnapshot);
    world.component(Trait).snapshotPolicy(DontSnapshot);
  }
}
