import { ChildOf, Iter, Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Chain, SingleShape } from "../shapes/components.js";
import { CollisionFilter, Material, Sensor } from "./components.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsCoreModule } from "../core/module.js";
import { recreateChainForEntity } from "../shapes/chain.js";
import { recreateSingleShapeForEntity } from "../shapes/lifecycle.js";
import { chainWithBodyParent, singleShapeWithBodyParent } from "../shapes/predicates.js";

export class MaterialFilterSyncModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsMaterialFilterSync:Material")
      .with(Material, singleShapeWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: Material,
          onEnter: true,
          cursor: Iter,
          inject: [SingleShape, { target: [ChildOf, [Body]] }],
        },
        (it, material, [shape, body]) => {
          if (requiresMaterialRecreate(engine, shape, material)) {
            // box2d3-wasm@5.2.0 exposes no shape setters for rollingResistance,
            // tangentSpeed, or userMaterialId, so those updates recreate the shape.
            recreateSingleShapeForEntity(engine, it.entity, it.entity.target(ChildOf), body, shape);
            return;
          }

          const shapeId = shape?._shapeId;
          if (shapeId !== undefined) {
            engine.box2d.b2Shape_SetDensity(shapeId, material.density, true);
            engine.box2d.b2Shape_SetFriction(shapeId, material.friction);
            engine.box2d.b2Shape_SetRestitution(shapeId, material.restitution);
          }
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsMaterialFilterSync:ChainMaterial")
      .with(Material, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: Material,
          onEnter: true,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _material, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsMaterialFilterSync:CollisionFilter")
      .with(CollisionFilter, singleShapeWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: CollisionFilter,
          onEnter: true,
          cursor: Iter,
          inject: [SingleShape, { target: [ChildOf, [Body]] }],
        },
        (_it, filter, [shape]) => {
          const shapeId = shape?._shapeId;
          if (shapeId !== undefined) {
            withAllocated(
              () => new engine.box2d.b2Filter(),
              (wasmFilter) => {
                // Public filters are 32-bit numbers; Box2D stores 64-bit masks. The
                // decimal string setters zero-pad the upper 32 bits explicitly.
                wasmFilter.setCategoryBits64(String(filter.categoryBits >>> 0));
                wasmFilter.setMaskBits64(String(filter.maskBits >>> 0));
                wasmFilter.groupIndex = filter.groupIndex;
                engine.box2d.b2Shape_SetFilter(shapeId, wasmFilter);
              }
            );
          }
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsMaterialFilterSync:ChainCollisionFilter")
      .with(CollisionFilter, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: CollisionFilter,
          onEnter: true,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _filter, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsMaterialFilterSync:Sensor")
      .with(Sensor, singleShapeWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: Sensor,
          onEnter: true,
          cursor: Iter,
          inject: [SingleShape, { target: [ChildOf, [Body]] }],
        },
        (it, _sensor, [shape, body]) => {
          recreateSingleShapeForEntity(engine, it.entity, it.entity.target(ChildOf), body, shape);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsMaterialFilterSync:ChainSensor")
      .with(Sensor, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: Sensor,
          onEnter: true,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _sensor, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .add(PhysicsSystemTag);
  }
}

function requiresMaterialRecreate(
  engine: PhysicsEngine,
  shape: SingleShape | undefined,
  next: Material
): boolean {
  if (shape === undefined) {
    return false;
  }

  const shapeId = shape._shapeId;
  if (shapeId === undefined || !engine.box2d.b2Shape_IsValid(shapeId)) {
    return false;
  }

  const materialData = engine.box2d.b2Shape_GetSurfaceMaterial(shapeId);
  try {
    return (
      materialData.rollingResistance !== next.rollingResistance ||
      materialData.tangentSpeed !== next.tangentSpeed ||
      Number(materialData.userMaterialId) !== next.userMaterialId
    );
  } finally {
    materialData.delete();
  }
}
