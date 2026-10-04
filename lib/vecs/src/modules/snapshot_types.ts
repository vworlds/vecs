// Snapshot policy trait, its policy values, and the declaration helpers that
// read and write them.
//
// Everything `component.ts` needs lives here rather than in `snapshot.ts`, which
// pulls in `module.ts` and would close the `component.ts` -> `module.ts` ->
// `component.ts` cycle at class-definition time. `SnapshotModule` keeps only the
// runtime invariants it installs, mirroring the `relationship_types.ts` /
// `relationships.ts` split.

import type { ComponentMeta, ComponentInstance } from "../component_meta.js";
import { Relationship } from "../component_meta.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/world.js";

/**
 * Captures one live component instance into detached, world-agnostic data.
 *
 * The returned value is stored in the snapshot and handed back to
 * {@link SnapshotMaterialize} verbatim, so it must not reference the source
 * world, its entities, or any mutable instance the source still holds.
 */
export type SnapshotCapture = (instance: ComponentInstance) => unknown;

/**
 * Constructs one destination-owned component instance from previously captured
 * data. The returned instance must be freshly constructed and belong to no
 * other entity.
 */
export type SnapshotMaterialize = (data: unknown) => ComponentInstance;

/**
 * Built-in pair-form trait declaring how {@link World.snapshotSubtree} captures
 * one component type.
 *
 * The trait is attached to the **component entity**, not to ordinary entities,
 * and its target selects the policy. It is exclusive, one-of
 * {@link OneOf | restricted to its own children}. Configure it through the
 * owning module; declarations affect future captures, while each existing
 * snapshot retains the materializer bound at its capture time.
 *
 * ```ts
 * // Declare "this type never crosses worlds" (resources, live queries, engines).
 * world.component(PhysicsEngine).snapshotPolicy(DontSnapshot);
 *
 * // Declare a bespoke capture that drops runtime handles.
 * world.component(Body).snapshotPolicy(CustomSnapshot, {
 *   capture: (body) => ({ ...body, _bodyId: undefined }),
 *   materialize: (data) => Object.assign(new Body(), data),
 * });
 * ```
 *
 * A type with no {@link OnSnapshot} edge uses {@link ClonePublic}, so ordinary
 * plain-data components need no declaration at all.
 */
export class OnSnapshot extends Relationship {
  /**
   * Capture hook for the {@link CustomSnapshot} policy. `undefined` for every
   * other policy.
   */
  public capture: SnapshotCapture | undefined = undefined;

  /**
   * Materialize hook for the {@link CustomSnapshot} policy. `undefined` for
   * every other policy.
   */
  public materialize: SnapshotMaterialize | undefined = undefined;
}

/**
 * Default snapshot policy: construct a fresh instance of the component class
 * and clone the source instance's own enumerable fields onto it.
 *
 * Shallow, and therefore exactly as aliasing-sensitive as `set`: a component
 * holding a nested object shares it with the source until something copies it.
 * A type that must not carry runtime handles across worlds needs its own
 * policy — see {@link CustomSnapshot}.
 */
export class ClonePublic {}

/**
 * Snapshot policy declaring that a component type never crosses worlds.
 *
 * Use it for attached resources and other instances whose identity is bound to
 * a single world: live queries and systems, engine handles, socket sessions.
 * A snapshot silently omits an unselected `DontSnapshot` type, but *selecting*
 * one explicitly is a preflight error, so a caller cannot silently lose state
 * it asked for.
 */
export class DontSnapshot {}

/**
 * Snapshot policy delegating capture and materialization to the owner.
 *
 * Register it with {@link Component.snapshotPolicy}, passing the `capture` and
 * `materialize` callbacks; the callbacks are stored on that component entity's
 * own {@link OnSnapshot} edge, so each component type keeps a separate policy.
 */
export class CustomSnapshot {}
/** The policy values accepted by {@link Component.snapshotPolicy}. */
export type SnapshotPolicyType = typeof ClonePublic | typeof CustomSnapshot | typeof DontSnapshot;

/**
 * @internal A resolved {@link OnSnapshot} declaration for one component type.
 *
 * `clone` is the implicit default and carries no declaration.
 */
export type ResolvedSnapshotPolicy =
  | { readonly kind: "clone" }
  | { readonly kind: "none" }
  | {
      readonly kind: "custom";
      readonly capture: SnapshotCapture;
      readonly materialize: SnapshotMaterialize;
    };

/** @internal The policy a component type resolves to when it declares none. */
export const CLONE_PUBLIC: ResolvedSnapshotPolicy = { kind: "clone" };

/** @internal The policy a component type resolves to when it is excluded. */
export const NO_SNAPSHOT: ResolvedSnapshotPolicy = { kind: "none" };

/**
 * @internal Attach `policy` to `component`'s {@link OnSnapshot} edge and store
 * the custom callbacks when the policy needs them.
 *
 * Called by `Component.snapshotPolicy`; the `OnSnapshot` hooks installed by
 * `SnapshotModule` enforce the setup-time invariant.
 */
export function _declareSnapshotPolicy(
  component: Entity,
  policy: SnapshotPolicyType,
  capture?: SnapshotCapture,
  materialize?: SnapshotMaterialize
): void {
  const world = component.world;
  const target = world.component(policy);
  component.add(OnSnapshot, target);
  component.set(OnSnapshot, {
    capture: policy === CustomSnapshot ? capture : undefined,
    materialize: policy === CustomSnapshot ? materialize : undefined,
  });
}

/**
 * @internal Resolve the capture policy declared for `meta` in `world`.
 *
 * A type with no {@link OnSnapshot} declaration resolves to {@link CLONE_PUBLIC}.
 *
 * @throws If an `OnSnapshot` edge selects {@link CustomSnapshot} without both
 *   callbacks, which would otherwise restore as a silently empty component.
 */
export function _resolveSnapshotPolicy(world: World, meta: ComponentMeta): ResolvedSnapshotPolicy {
  const onSnapshot = world.component(OnSnapshot);
  const declaration = world.getEntity(meta.eid)?.get(onSnapshot.eid) as OnSnapshot | undefined;
  if (declaration === undefined) {
    return CLONE_PUBLIC;
  }
  const policy = declaration._target();
  if (policy === undefined || policy.eid === world.component(ClonePublic).eid) {
    return CLONE_PUBLIC;
  }
  if (policy.eid !== world.component(CustomSnapshot).eid) {
    return NO_SNAPSHOT;
  }
  if (declaration.capture === undefined || declaration.materialize === undefined) {
    throw new Error(
      `OnSnapshot policy for ${meta.Class.name} selects CustomSnapshot without capture and materialize callbacks`
    );
  }
  return {
    kind: "custom",
    capture: declaration.capture,
    materialize: declaration.materialize,
  };
}
