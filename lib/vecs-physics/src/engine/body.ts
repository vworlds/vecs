// Body data model: the three-way split Box2D uses for body storage, ported as
// plain object records (a TypedArray refactor stays possible later — see
// PLAN.md → _Body storage_).
//
// - `InternalBody` — sparse, indexed by a body handle's index. Organisational
//   fields the solver does not touch. Mirrors `b2Body`.
// - `BodySim` — dense, one per body in a solver set. Transform, mass, damping,
//   force. Mirrors `b2BodySim`.
// - `BodyState` — dense, only for bodies in the awake set. Velocity + solver
//   delta-pose. Mirrors `b2BodyState`.
//
// Engine module: no imports from `components/` or `systems/` (PLAN.md → _Module
// boundaries_). The body's owning `Entity`, its `type`, mass, and topology
// (shape/contact/island links) are added by the tickets that populate them;
// VP-5 keeps only what body storage and solver-set transfer touch.

import type { Entity } from "@vworlds/vecs";

import { HUGE } from "../math/constants.js";
import type { BodyHandle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";

// Numeric body types, mirroring `b2BodyType`. The public string `BodyType`
// (`components/body.ts`) is translated to one of these at the systems-layer
// boundary; the engine only ever sees the number.
export const STATIC_BODY = 0;
export const KINEMATIC_BODY = 1;
export const DYNAMIC_BODY = 2;

/** Sparse, organisational body record. Indexed by a {@link BodyHandle}'s index;
 * the solver never reads it. Mirrors `b2Body` minus the id-API surface. */
export interface InternalBody {
  /** The Vecs entity that owns this body. Set when the body is created from a
   * `Body`-bearing entity; used to write simulated pose back to its components.
   * Mirrors how `b2Body` carries `userData` back to the host. */
  entity: Entity;
  /** Numeric body type ({@link STATIC_BODY} / {@link KINEMATIC_BODY} /
   * {@link DYNAMIC_BODY}). Decides solver-set placement and pose write-back. */
  type: number;
  /** Which solver set this body lives in (see `solver_set.ts` constants). */
  setIndex: number;
  /** Index of this body's {@link BodySim} (and {@link BodyState}) within its set. */
  localIndex: number;
}

/** Dense per-body simulation data. One per body in a solver set. Transform and
 * integration inputs the solver reads every step. Mirrors `b2BodySim`. */
export interface BodySim {
  // Transform for the body origin: position + rotation as (cos, sin).
  transformX: number;
  transformY: number;
  cos: number;
  sin: number;

  // World-space centre of mass.
  centerX: number;
  centerY: number;

  // Previous-step rotation and centre, for time-of-impact (CCD).
  rotation0Cos: number;
  rotation0Sin: number;
  center0X: number;
  center0Y: number;

  // Centre of mass relative to the body origin.
  localCenterX: number;
  localCenterY: number;

  forceX: number;
  forceY: number;
  torque: number;

  invMass: number;
  invInertia: number;

  minExtent: number;
  maxExtent: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;

  /** Back-pointer to the owning {@link InternalBody}'s handle index. */
  bodyId: number;
  /** Bit flags (locks, bullet, …). Populated by later tickets; 0 for now. */
  flags: number;
}

/** Dense solver state. Exists only for bodies in the awake set. Velocity plus a
 * delta-pose the solver accumulates each step. Mirrors `b2BodyState`. */
export interface BodyState {
  vx: number;
  vy: number;
  omega: number;
  /** Bit flags, copied from the body's {@link BodySim} on creation. */
  flags: number;

  // Solver-local delta pose; reset each step. Delta rotation starts identity.
  deltaPosX: number;
  deltaPosY: number;
  deltaRotCos: number;
  deltaRotSin: number;
}

/** Owns the sparse {@link InternalBody} table and the index allocator that hands
 * out body handles. Solver-set transfer resolves a moved body's record through
 * {@link get} to fix its `localIndex`. */
export class BodyStorage {
  /** Sparse, indexed by a {@link BodyHandle}'s index; `undefined` for a freed
   * slot. Body sims/states live in the solver sets, addressed by `localIndex`. */
  public readonly records: (InternalBody | undefined)[] = [];

  /** Allocates body handle indices, stamping each with a generation. */
  public readonly idPool = new IdPool<BodyHandle>();

  /** The live body at a handle index. Throws if the slot is empty — callers
   * holding a `bodyId` back-pointer expect the record to exist. */
  public get(index: number): InternalBody {
    const body = this.records[index];
    if (body === undefined) {
      throw new Error(`no body at index ${index}`);
    }
    return body;
  }
}

/** A zeroed {@link BodySim} with identity rotation, back-pointing at `bodyId`.
 * `minExtent` starts at {@link HUGE} as in `b2CreateBody`; mass, damping, and
 * gravity scale are filled in when the body's components are read. */
export function makeBodySim(bodyId: number): BodySim {
  return {
    transformX: 0,
    transformY: 0,
    cos: 1,
    sin: 0,
    centerX: 0,
    centerY: 0,
    rotation0Cos: 1,
    rotation0Sin: 0,
    center0X: 0,
    center0Y: 0,
    localCenterX: 0,
    localCenterY: 0,
    forceX: 0,
    forceY: 0,
    torque: 0,
    invMass: 0,
    invInertia: 0,
    minExtent: HUGE,
    maxExtent: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    bodyId,
    flags: 0,
  };
}

/** Write a new origin transform into `sim` and resync the centre-of-mass sweep,
 * mirroring `b2Body_SetTransform` minus the broad-phase refit (no proxies until
 * shapes land). The rotation is supplied pre-resolved as `(cos, sin)`. The
 * world-space centre is recomputed from the body-local centre, and the previous
 * sweep (`rotation0`/`center0`) is reset to the new pose so a teleport leaves no
 * stale motion baseline. */
export function writeBodyTransform(
  sim: BodySim,
  x: number,
  y: number,
  cos: number,
  sin: number
): void {
  sim.transformX = x;
  sim.transformY = y;
  sim.cos = cos;
  sim.sin = sin;
  // center = transformPoint(transform, localCenter)
  const cx = x + (cos * sim.localCenterX - sin * sim.localCenterY);
  const cy = y + (sin * sim.localCenterX + cos * sim.localCenterY);
  sim.centerX = cx;
  sim.centerY = cy;
  sim.rotation0Cos = cos;
  sim.rotation0Sin = sin;
  sim.center0X = cx;
  sim.center0Y = cy;
}

/** A zeroed {@link BodyState} with identity delta rotation, carrying `flags`.
 * Mirrors `b2_identityBodyState` with the body's flags applied. */
export function makeIdentityBodyState(flags: number): BodyState {
  return {
    vx: 0,
    vy: 0,
    omega: 0,
    flags,
    deltaPosX: 0,
    deltaPosY: 0,
    deltaRotCos: 1,
    deltaRotSin: 0,
  };
}
