import { type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "../components/body.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "../components/body_tuning.js";
import { type Box2DModule } from "../adapter/runtime.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";
import { withAllocated } from "../adapter/disposal.js";
import { destroyBodyContacts } from "../engine/contact.js";
import { createIslandForBody, removeBodyFromIsland } from "../engine/island.js";
import { updateShapeAABBs } from "../engine/shape.js";
import { makeRot } from "../math/rot.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { swapRemove } from "../util/dense_array.js";
import { NULL_INDEX, type BodyHandle } from "../util/handle.js";

const STATIC_BODY = 0;
const KINEMATIC_BODY = 1;
const DYNAMIC_BODY = 2;
const STATIC_SET = 0;
const DISABLED_SET = 1;
const AWAKE_SET = 2;
const LOCK_LINEAR_X = 0x0001;
const LOCK_LINEAR_Y = 0x0002;
const LOCK_ANGULAR_Z = 0x0004;
const IS_BULLET = 0x0010;
const ALLOW_FAST_ROTATION = 0x0080;
const DYNAMIC_FLAG = 0x0200;
const ENABLE_SLEEP = 0x0800;
const BODY_TRANSIENT_FLAGS = 0x0008 | 0x0020 | 0x0040;

export function installBodyLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world.system("PhysicsBodyLifecycle").requires(Body).phase(phase);

  system.enter((entity) => {
    const body = entity.get(Body)!;
    const bodyId = createWasmBodyId(state, entity, body);
    state.bodyByEntityWasm.set(entity.eid, bodyId);
    state.entityByBody.set(bodyId, entity.eid);
    createLegacyBodyRecord(state, entity, body);
  });

  system.exit((entity) => {
    const bodyId = state.bodyByEntityWasm.get(entity.eid);
    if (bodyId !== undefined) {
      state.box2d.b2DestroyBody(bodyId);
      state.bodyByEntityWasm.delete(entity.eid);
      state.entityByBody.delete(bodyId);
    }

    const handle = state.bodyByEntity.get(entity.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);
    const setIndex = record.setIndex;
    destroyBodyContacts(state, handle.index, false);
    destroyLegacyBody(state, state.solverSets[setIndex]!, handle);
    state.bodyByEntity.delete(entity.eid);
  });

  system.update(Body, (entity, body) => {
    const bodyId = state.bodyByEntityWasm.get(entity.eid);
    if (bodyId !== undefined) {
      state.box2d.b2Body_SetType(bodyId, bodyTypeToBox2D(state.box2d, body.type));
      if (body.enabled) {
        state.box2d.b2Body_Enable(bodyId);
      } else {
        state.box2d.b2Body_Disable(bodyId);
      }
      state.box2d.b2Body_SetBullet(bodyId, body.bullet);
    }
    updateLegacyBodyRecord(state, entity, body);
  });

  system.update(MotionLocks, (entity, locks) => {
    const handle = state.bodyByEntity.get(entity.eid);
    if (handle === undefined) {
      return;
    }
    const lockBits =
      (locks.x ? LOCK_LINEAR_X : 0) |
      (locks.y ? LOCK_LINEAR_Y : 0) |
      (locks.rotation ? LOCK_ANGULAR_Z : 0);
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    const lockMask = LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z;
    sim.flags = (sim.flags & ~lockMask) | lockBits;
    if (record.setIndex === AWAKE_SET) {
      const bodyState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
      if (bodyState !== undefined) {
        bodyState.flags = (bodyState.flags & ~lockMask) | lockBits;
      }
    }
  });

  system.update(Sleep, (entity, sleep) => {
    const bodyId = state.bodyByEntityWasm.get(entity.eid);
    if (bodyId !== undefined) {
      state.box2d.b2Body_EnableSleep(bodyId, sleep.enabled);
      state.box2d.b2Body_SetAwake(bodyId, sleep.awake);
      state.box2d.b2Body_SetSleepThreshold(bodyId, sleep.threshold);
    }

    const handle = state.bodyByEntity.get(entity.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);
    if (sleep.enabled) {
      record.flags |= ENABLE_SLEEP;
    } else {
      record.flags &= ~ENABLE_SLEEP;
    }
    record.sleepThreshold = sleep.threshold;
  });

  return system;
}

function createWasmBodyId(state: PhysicsState, entity: Entity, body: Body): b2BodyId {
  const box2d = state.box2d;
  return withAllocated(box2d.b2DefaultBodyDef, (def) => {
    const position = entity.get(Position);
    const rotation = entity.get(Rotation);
    const linearVelocity = entity.get(LinearVelocity);
    const angularVelocity = entity.get(AngularVelocity);
    const damping = entity.get(Damping);
    const gravityScale = entity.get(GravityScale);
    const motionLocks = entity.get(MotionLocks);
    const sleep = entity.get(Sleep);

    def.type = bodyTypeToBox2D(box2d, body.type);
    def.position.Set(position?.x ?? 0, position?.y ?? 0);
    def.rotation.SetAngle(rotation?.angle ?? 0);
    def.linearVelocity.Set(linearVelocity?.x ?? 0, linearVelocity?.y ?? 0);
    def.angularVelocity = angularVelocity?.value ?? 0;
    def.linearDamping = damping?.linear ?? 0;
    def.angularDamping = damping?.angular ?? 0;
    def.gravityScale = gravityScale?.value ?? 1;
    def.motionLocks.linearX = motionLocks?.x ?? false;
    def.motionLocks.linearY = motionLocks?.y ?? false;
    def.motionLocks.angularZ = motionLocks?.rotation ?? false;
    def.enableSleep = sleep?.enabled ?? true;
    def.isAwake = sleep?.awake ?? true;
    def.sleepThreshold = sleep?.threshold ?? 0.05;
    def.isEnabled = body.enabled;
    def.isBullet = body.bullet;
    def.allowFastRotation = body.allowFastRotation;

    return box2d.b2CreateBody(state.worldId, def);
  });
}

function createLegacyBodyRecord(state: PhysicsState, entity: Entity, body: Body): void {
  const type = bodyTypeToNumber(body.type);
  const setIndex = chooseSetIndex(body);
  const set = state.solverSets[setIndex]!;
  const handle = state.bodies.idPool.allocate();
  const sim = makeLegacyBodySim(handle.index);
  if (type === DYNAMIC_BODY) {
    sim.flags |= DYNAMIC_FLAG;
  }
  const record = {
    entity,
    type,
    setIndex,
    localIndex: set.bodySims.length,
    shapeHead: NULL_INDEX,
    shapeCount: 0,
    massDirty: false,
    headContactKey: NULL_INDEX,
    contactCount: 0,
    islandId: NULL_INDEX,
    islandIndex: NULL_INDEX,
    sleepTime: 0,
    sleepThreshold: 0.05,
    flags: 0,
    bodyMoveIndex: NULL_INDEX,
  };

  state.bodies.records[handle.index] = record;
  set.bodySims.push(sim);
  if (setIndex === AWAKE_SET) {
    set.bodyStates.push(makeLegacyBodyState(sim.flags));
  }
  if (setIndex === AWAKE_SET && type !== STATIC_BODY) {
    createIslandForBody(state, AWAKE_SET, record);
  }

  const sleep = entity.get(Sleep);
  const sleepEnabled = sleep?.enabled !== false;
  if (sleepEnabled) {
    record.flags |= ENABLE_SLEEP;
  }
  if (sleep?.threshold !== undefined) {
    record.sleepThreshold = sleep.threshold;
  }
  if (
    state.enableSleep &&
    body.type !== BodyType.Static &&
    body.enabled &&
    sleep !== undefined &&
    sleep.awake === false &&
    sleepEnabled
  ) {
    record.sleepTime = 1.0;
  }

  const position = entity.get(Position);
  const rotation = entity.get(Rotation);
  const q = makeRot(rotation?.angle ?? 0);
  writeLegacyBodyTransform(sim, position?.x ?? 0, position?.y ?? 0, q.c, q.s);

  const damping = entity.get(Damping);
  if (damping) {
    sim.linearDamping = damping.linear;
    sim.angularDamping = damping.angular;
  }
  const gravityScale = entity.get(GravityScale);
  if (gravityScale) {
    sim.gravityScale = gravityScale.value;
  }

  const extraFlags =
    motionLockBits(entity) |
    (body.allowFastRotation ? ALLOW_FAST_ROTATION : 0) |
    (body.bullet ? IS_BULLET : 0);
  if (extraFlags !== 0) {
    sim.flags |= extraFlags;
    if (setIndex === AWAKE_SET) {
      set.bodyStates[record.localIndex]!.flags |= extraFlags;
    }
  }

  if (setIndex === AWAKE_SET) {
    const bodyState = set.bodyStates[record.localIndex]!;
    const linear = entity.get(LinearVelocity);
    if (linear) {
      bodyState.vx = linear.x;
      bodyState.vy = linear.y;
    }
    const angular = entity.get(AngularVelocity);
    if (angular) {
      bodyState.omega = angular.value;
    }
  }

  state.bodyByEntity.set(entity.eid, handle);
}

function updateLegacyBodyRecord(state: PhysicsState, entity: Entity, body: Body): void {
  const handle = state.bodyByEntity.get(entity.eid);
  if (handle === undefined) {
    return;
  }
  const record = state.bodies.get(handle.index);
  const wasDisabled = record.setIndex === DISABLED_SET;
  const wasStatic = record.type === STATIC_BODY;
  const targetSetIndex = chooseSetIndex(body);
  const willBeDisabled = targetSetIndex === DISABLED_SET;
  const willBeStatic = targetSetIndex === STATIC_SET;
  const newType = bodyTypeToNumber(body.type);
  const typeChanged = newType !== record.type;

  if (!typeChanged && targetSetIndex === record.setIndex) {
    syncLegacyBodyFlags(state, record, body);
    return;
  }
  if (!wasDisabled) {
    destroyBodyContacts(state, handle.index, false);
  }
  if (wasDisabled && willBeDisabled && typeChanged) {
    record.type = newType;
    const sim = state.solverSets[DISABLED_SET]!.bodySims[record.localIndex]!;
    if (newType === DYNAMIC_BODY) {
      sim.flags |= DYNAMIC_FLAG;
    } else {
      sim.flags &= ~DYNAMIC_FLAG;
    }
    record.massDirty = true;
    return;
  }
  if (!wasDisabled && willBeDisabled) {
    destroyBodyShapeProxies(state, record);
  }
  if (!wasDisabled && (willBeDisabled || willBeStatic)) {
    removeBodyFromIsland(state, record);
  }

  record.type = newType;
  const currentSim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
  if (newType === DYNAMIC_BODY) {
    currentSim.flags |= DYNAMIC_FLAG;
  } else {
    currentSim.flags &= ~DYNAMIC_FLAG;
  }
  if (targetSetIndex !== record.setIndex) {
    transferLegacyBody(
      state.bodies,
      state.solverSets[targetSetIndex]!,
      state.solverSets[record.setIndex]!,
      record
    );
  }
  if (typeChanged) {
    record.massDirty = true;
  }
  if (wasDisabled && !willBeDisabled) {
    createBodyShapeProxies(state, record, newType);
  } else if (!wasDisabled && !willBeDisabled && typeChanged) {
    destroyBodyShapeProxies(state, record);
    createBodyShapeProxies(state, record, newType);
  }
  if (!willBeDisabled && !willBeStatic && (wasDisabled || wasStatic)) {
    createIslandForBody(state, AWAKE_SET, record);
  }
  if (record.setIndex === AWAKE_SET) {
    const bodyState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
    if (bodyState !== undefined) {
      if (newType === DYNAMIC_BODY) {
        bodyState.flags |= DYNAMIC_FLAG;
      } else {
        bodyState.flags &= ~DYNAMIC_FLAG;
      }
    }
  }
  syncLegacyBodyFlags(state, record, body);
}

function destroyBodyShapeProxies(
  state: PhysicsState,
  bodyRecord: ReturnType<typeof state.bodies.get>
): void {
  let shapeIndex = bodyRecord.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const shape = state.shapes.get(shapeIndex);
    shapeIndex = shape.nextShape;
    if (shape.proxyKey !== -1) {
      state.broadPhase.destroyProxy(shape.proxyKey);
      shape.proxyKey = -1;
    }
  }
}

function createBodyShapeProxies(
  state: PhysicsState,
  bodyRecord: ReturnType<typeof state.bodies.get>,
  newBodyType: number
): void {
  const sim = state.solverSets[bodyRecord.setIndex]!.bodySims[bodyRecord.localIndex]!;
  const bodyXf: Transform = {
    p: { x: sim.transformX, y: sim.transformY },
    q: { c: sim.cos, s: sim.sin },
  };
  let shapeIndex = bodyRecord.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const currentIndex = shapeIndex;
    const shape = state.shapes.get(currentIndex);
    shapeIndex = shape.nextShape;
    const localXf: Transform = {
      p: { x: shape.localX, y: shape.localY },
      q: { c: shape.localCos, s: shape.localSin },
    };
    const fatAABB = updateShapeAABBs(shape, mulTransforms(bodyXf, localXf), newBodyType);
    shape.proxyKey = state.broadPhase.createProxy(
      newBodyType,
      fatAABB,
      shape.categoryBits,
      currentIndex,
      true
    );
  }
}

function destroyLegacyBody(
  state: PhysicsState,
  set: PhysicsState["solverSets"][number],
  handle: BodyHandle
): void {
  const storage = state.bodies;
  const body = storage.get(handle.index);
  removeBodyFromIsland(state, body);
  const localIndex = body.localIndex;
  removeLegacyBodySim(set, localIndex, storage);
  if (set.setIndex === AWAKE_SET) {
    swapRemove(set.bodyStates, localIndex);
  }
  storage.records[handle.index] = undefined;
  storage.idPool.free(handle);
}

function transferLegacyBody(
  storage: PhysicsState["bodies"],
  targetSet: PhysicsState["solverSets"][number],
  sourceSet: PhysicsState["solverSets"][number],
  body: ReturnType<PhysicsState["bodies"]["get"]>
): void {
  if (targetSet === sourceSet) {
    return;
  }
  const sourceIndex = body.localIndex;
  const sim = sourceSet.bodySims[sourceIndex]!;
  const targetIndex = targetSet.bodySims.length;
  targetSet.bodySims.push(sim);
  sim.flags &= ~BODY_TRANSIENT_FLAGS;
  removeLegacyBodySim(sourceSet, sourceIndex, storage);
  if (sourceSet.setIndex === AWAKE_SET) {
    swapRemove(sourceSet.bodyStates, sourceIndex);
  } else if (targetSet.setIndex === AWAKE_SET) {
    targetSet.bodyStates.push(makeLegacyBodyState(sim.flags));
  }
  body.setIndex = targetSet.setIndex;
  body.localIndex = targetIndex;
}

function removeLegacyBodySim(
  set: PhysicsState["solverSets"][number],
  localIndex: number,
  storage: PhysicsState["bodies"]
): void {
  const moved = swapRemove(set.bodySims, localIndex);
  if (moved !== undefined) {
    storage.get(moved.bodyId).localIndex = localIndex;
  }
}

function syncLegacyBodyFlags(
  state: PhysicsState,
  record: ReturnType<PhysicsState["bodies"]["get"]>,
  body: Body
): void {
  const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
  if (body.allowFastRotation) {
    sim.flags |= ALLOW_FAST_ROTATION;
  } else {
    sim.flags &= ~ALLOW_FAST_ROTATION;
  }
  if (body.bullet) {
    sim.flags |= IS_BULLET;
  } else {
    sim.flags &= ~IS_BULLET;
  }
  if (record.setIndex === AWAKE_SET) {
    const bodyState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
    if (bodyState !== undefined) {
      if (body.allowFastRotation) {
        bodyState.flags |= ALLOW_FAST_ROTATION;
      } else {
        bodyState.flags &= ~ALLOW_FAST_ROTATION;
      }
    }
  }
}

function motionLockBits(entity: Entity): number {
  const locks = entity.get(MotionLocks);
  if (!locks) {
    return 0;
  }
  return (
    (locks.x ? LOCK_LINEAR_X : 0) |
    (locks.y ? LOCK_LINEAR_Y : 0) |
    (locks.rotation ? LOCK_ANGULAR_Z : 0)
  );
}

function makeLegacyBodySim(bodyId: number) {
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
    minExtent: Number.MAX_VALUE,
    maxExtent: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    bodyId,
    flags: 0,
  };
}

function makeLegacyBodyState(flags: number) {
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

function writeLegacyBodyTransform(
  sim: ReturnType<typeof makeLegacyBodySim>,
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

function chooseSetIndex(body: Readonly<Body>): number {
  if (!body.enabled) {
    return DISABLED_SET;
  }
  if (body.type === BodyType.Static) {
    return STATIC_SET;
  }
  return AWAKE_SET;
}

function bodyTypeToNumber(type: BodyType): number {
  switch (type) {
    case BodyType.Static:
      return STATIC_BODY;
    case BodyType.Kinematic:
      return KINEMATIC_BODY;
    case BodyType.Dynamic:
      return DYNAMIC_BODY;
  }
}

function bodyTypeToBox2D(
  box2d: Box2DModule,
  type: BodyType
): ReturnType<Box2DModule["b2Body_GetType"]> {
  switch (type) {
    case BodyType.Static:
      return box2d.b2BodyType.b2_staticBody;
    case BodyType.Kinematic:
      return box2d.b2BodyType.b2_kinematicBody;
    case BodyType.Dynamic:
      return box2d.b2BodyType.b2_dynamicBody;
  }
}
