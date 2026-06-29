import { ChildOf, Iter, Module, type Entity } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Chain } from "./components.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsCoreModule } from "../core/module.js";
import { chainWithBodyParent } from "./predicates.js";
import {
  applyChainDef,
  markParentBodyMassDirty,
  readLocalPose,
  readShapeOptions,
} from "./lifecycle.js";

export class ChainLifecycleModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsChainLifecycle")
      .with(chainWithBodyParent)
      .phase(phase)
      .enter(
        { cursor: Iter, inject: [Chain, { target: [ChildOf, [Body]] }] },
        (it, [chain, body]) => {
          createChainForEntity(engine, it.entity, it.src[1], body, chain);
        }
      )
      .exit([ChildOf, Chain], (entity, [childOf, chain]) => {
        destroyChainForEntity(engine, entity, true, childOf?.target, chain);
      })
      .update(
        { watch: Chain, cursor: Iter, inject: [{ target: [ChildOf, [Body]] }] },
        (it, chain, [body]) => {
          recreateChainForEntity(engine, it.entity, it.src[0], body, chain);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsChainLifecycle:ChildOf")
      .with(ChildOf, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: ChildOf,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _childOf, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
        }
      )
      .add(PhysicsSystemTag);
  }
}

export function recreateChainForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  parentEntity: Entity | undefined,
  parentBody: Body | undefined,
  chain: Chain | undefined
): void {
  destroyChainForEntity(engine, entity, false, parentEntity, chain);
  createChainForEntity(engine, entity, parentEntity, parentBody, chain);
}

function createChainForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  parentEntity: Entity | undefined,
  parentBody: Body | undefined,
  chain: Chain | undefined
): void {
  const bodyId = parentBody?._bodyId;
  if (parentEntity === undefined || bodyId === undefined || chain === undefined) {
    return;
  }
  createChain(engine, entity, parentEntity, bodyId, chain);
}

// `deferDestroy` mirrors destroyShapeForEntity: the exit defers the b2DestroyChain
// to PhysicsReaper (chain still live until then), the in-place recreate destroys
// now. No cascade/validity guard needed in either case.
function destroyChainForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  deferDestroy: boolean,
  parent?: Entity,
  chain?: Readonly<Chain>
): void {
  const resolvedParent = parent ?? entity.parent;
  const resolvedChain = chain ?? entity.get(Chain);
  const chainId = resolvedChain?._chainId;
  if (resolvedChain !== undefined) {
    for (const index of resolvedChain._segmentIndices) {
      engine.entityByShapeIndex.delete(index);
    }
    resolvedChain._segmentIndices.length = 0;
  }
  if (chainId === undefined) {
    return;
  }

  if (deferDestroy) {
    engine.pendingChainDestroys.push(chainId);
  } else {
    engine.box2d.b2DestroyChain(chainId);
  }
  markParentBodyMassDirty(engine, resolvedParent);

  const mutableChain = entity.get(Chain) as Chain | undefined;
  if (mutableChain !== undefined) {
    mutableChain._chainId = undefined;
  }
}

function createChain(
  engine: PhysicsEngine,
  entity: Entity,
  parent: Entity,
  bodyId: b2BodyId,
  chain: Chain
): void {
  if (chain.points.length < 4) {
    return;
  }

  const box2d = engine.box2d;
  const pose = readLocalPose(entity);
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  const points = chain.points.map(
    (point) =>
      new box2d.b2Vec2(
        point.x * cos - point.y * sin + pose.x,
        point.x * sin + point.y * cos + pose.y
      )
  );
  try {
    const chainId = withAllocated(box2d.b2DefaultChainDef, (def) => {
      applyChainDef(def, readShapeOptions(entity));
      def.isLoop = chain.loop;
      def.count = points.length;
      def.SetPoints(points);
      return box2d.b2CreateChain(bodyId, def);
    });
    chain._chainId = chainId;
    registerChainSegments(engine, entity, chain);
    markParentBodyMassDirty(engine, parent);
  } finally {
    for (const point of points) {
      point.delete();
    }
  }
}

function registerChainSegments(engine: PhysicsEngine, entity: Entity, chain: Chain): void {
  const chainId = chain._chainId;
  if (chainId === undefined) {
    return;
  }

  const count = engine.box2d.b2Chain_GetSegmentCount(chainId);
  const segments = engine.box2d.b2Chain_GetSegments(chainId, count) as Array<{ index1: number }>;
  for (const segment of segments) {
    engine.entityByShapeIndex.set(segment.index1, entity.eid);
    chain._segmentIndices.push(segment.index1);
  }
}
