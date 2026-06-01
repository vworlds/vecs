// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.

import type { Entity } from "@vworlds/vecs";

import { HUGE } from "../math/constants.js";
import { NULL_INDEX, type BodyHandle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";

export const STATIC_BODY = 0;
export const KINEMATIC_BODY = 1;
export const DYNAMIC_BODY = 2;

export const LOCK_LINEAR_X = 0x0001;
export const LOCK_LINEAR_Y = 0x0002;
export const LOCK_ANGULAR_Z = 0x0004;
export const IS_FAST = 0x0008;
export const IS_BULLET = 0x0010;
export const IS_SPEED_CAPPED = 0x0020;
export const HAD_TIME_OF_IMPACT = 0x0040;
export const ALLOW_FAST_ROTATION = 0x0080;
export const ENLARGE_BOUNDS = 0x0100;
export const DYNAMIC_FLAG = 0x0200;
export const ENABLE_SLEEP = 0x0800;
export const BODY_TRANSIENT_FLAGS = IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT;

export interface InternalBody {
  entity: Entity;
  type: number;
  setIndex: number;
  localIndex: number;
  shapeHead: number;
  shapeCount: number;
  massDirty: boolean;
  headContactKey: number;
  contactCount: number;
  islandId: number;
  islandIndex: number;
  sleepTime: number;
  sleepThreshold: number;
  flags: number;
  bodyMoveIndex: number;
}

export interface BodySim {
  transformX: number;
  transformY: number;
  cos: number;
  sin: number;
  centerX: number;
  centerY: number;
  rotation0Cos: number;
  rotation0Sin: number;
  center0X: number;
  center0Y: number;
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
  bodyId: number;
  flags: number;
}

export interface BodyState {
  vx: number;
  vy: number;
  omega: number;
  flags: number;
  deltaPosX: number;
  deltaPosY: number;
  deltaRotCos: number;
  deltaRotSin: number;
}

export class BodyStorage {
  public readonly records: (InternalBody | undefined)[] = [];
  public readonly idPool = new IdPool<BodyHandle>();

  public get(index: number): InternalBody {
    const body = this.records[index];
    if (body === undefined) {
      throw new Error(`no body at index ${index}`);
    }
    return body;
  }
}

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
  const cx = x + (cos * sim.localCenterX - sin * sim.localCenterY);
  const cy = y + (sin * sim.localCenterX + cos * sim.localCenterY);
  sim.centerX = cx;
  sim.centerY = cy;
  sim.rotation0Cos = cos;
  sim.rotation0Sin = sin;
  sim.center0X = cx;
  sim.center0Y = cy;
}
