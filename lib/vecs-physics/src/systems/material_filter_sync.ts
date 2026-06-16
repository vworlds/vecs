import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Chain, SingleShape } from "../components/geometry.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { recreateChainForEntity } from "./chain_lifecycle.js";
import { recreateSingleShapeForEntity } from "./shape_lifecycle.js";
import { chainWithBodyParent, singleShapeWithBodyParent } from "./shape_predicates.js";

export function installMaterialFilterSync(
  world: World,
  engine: PhysicsEngine,
  phase: Entity
): void {
  const system = world
    .system("PhysicsMaterialFilterSync:Material")
    .with(Material, singleShapeWithBodyParent)
    .phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.update(
    { cursor: Iter, component: Material, inject: [SingleShape, { target: [ChildOf, [Body]] }] },
    (it, material, [shape, body]) => {
      if (requiresMaterialRecreate(engine, shape, material)) {
        // box2d3-wasm@5.2.0 exposes no shape setters for rollingResistance,
        // tangentSpeed, or userMaterialId, so those updates recreate the shape.
        recreateSingleShapeForEntity(engine, it.entity, it.src[1], body, shape);
        return;
      }

      const shapeId = shape?._shapeId;
      if (shapeId !== undefined) {
        engine.box2d.b2Shape_SetDensity(shapeId, material.density, true);
        engine.box2d.b2Shape_SetFriction(shapeId, material.friction);
        engine.box2d.b2Shape_SetRestitution(shapeId, material.restitution);
      }
    }
  );

  const chainMaterialSystem = world
    .system("PhysicsMaterialFilterSync:ChainMaterial")
    .with(Material, chainWithBodyParent)
    .phase(phase)
    .update(
      { cursor: Iter, component: Material, inject: [Chain, { target: [ChildOf, [Body]] }] },
      (it, _material, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    );
  chainMaterialSystem.entity.add(PhysicsSystemTag);

  const collisionFilterSystem = world
    .system("PhysicsMaterialFilterSync:CollisionFilter")
    .with(CollisionFilter, singleShapeWithBodyParent)
    .phase(phase)
    .update(
      {
        cursor: Iter,
        component: CollisionFilter,
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
    );
  collisionFilterSystem.entity.add(PhysicsSystemTag);

  const chainCollisionFilterSystem = world
    .system("PhysicsMaterialFilterSync:ChainCollisionFilter")
    .with(CollisionFilter, chainWithBodyParent)
    .phase(phase)
    .update(
      { cursor: Iter, component: CollisionFilter, inject: [Chain, { target: [ChildOf, [Body]] }] },
      (it, _filter, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    );
  chainCollisionFilterSystem.entity.add(PhysicsSystemTag);

  const sensorSystem = world
    .system("PhysicsMaterialFilterSync:Sensor")
    .with(Sensor, singleShapeWithBodyParent)
    .phase(phase)
    .update(
      { cursor: Iter, component: Sensor, inject: [SingleShape, { target: [ChildOf, [Body]] }] },
      (it, _sensor, [shape, body]) => {
        recreateSingleShapeForEntity(engine, it.entity, it.src[1], body, shape);
      }
    );
  sensorSystem.entity.add(PhysicsSystemTag);

  const chainSensorSystem = world
    .system("PhysicsMaterialFilterSync:ChainSensor")
    .with(Sensor, chainWithBodyParent)
    .phase(phase)
    .update(
      { cursor: Iter, component: Sensor, inject: [Chain, { target: [ChildOf, [Body]] }] },
      (it, _sensor, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    );
  chainSensorSystem.entity.add(PhysicsSystemTag);
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
