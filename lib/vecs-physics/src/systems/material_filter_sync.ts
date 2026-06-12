import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Chain, Shape } from "../components/geometry.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsSystemTag, type b2ShapeId, type PhysicsState } from "../adapter/state.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";
import { shapeWithBodyParent } from "./shape_predicates.js";

export function installMaterialFilterSync(world: World, state: PhysicsState, phase: Entity): void {
  const system = world
    .system("PhysicsMaterialFilterSync:Material")
    .with(Material, shapeWithBodyParent)
    .phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.update(Iter, Material, [Shape, { target: [ChildOf, [Body]] }], (it, material, tuple) => {
    const [shape, body] = tuple;
    if (requiresMaterialRecreate(state, shape, material)) {
      // box2d3-wasm@5.2.0 exposes no shape setters for rollingResistance,
      // tangentSpeed, or userMaterialId, so those updates recreate the shape.
      recreateShapeForEntity(state, it.entity, it.src[1], body, shape);
      return;
    }

    if (shape instanceof Chain) {
      recreateShapeForEntity(state, it.entity, it.src[1], body, shape);
      return;
    }

    const shapeId = shape?._shapeId as b2ShapeId | undefined;
    if (shapeId !== undefined) {
      state.box2d.b2Shape_SetDensity(shapeId, material.density, true);
      state.box2d.b2Shape_SetFriction(shapeId, material.friction);
      state.box2d.b2Shape_SetRestitution(shapeId, material.restitution);
    }
  });

  const collisionFilterSystem = world
    .system("PhysicsMaterialFilterSync:CollisionFilter")
    .with(CollisionFilter, shapeWithBodyParent)
    .phase(phase)
    .update(Iter, CollisionFilter, [Shape, { target: [ChildOf, [Body]] }], (it, filter, tuple) => {
      const [shape, body] = tuple;
      if (shape instanceof Chain) {
        recreateShapeForEntity(state, it.entity, it.src[1], body, shape);
        return;
      }

      const shapeId = shape?._shapeId as b2ShapeId | undefined;
      if (shapeId !== undefined) {
        withAllocated(
          () => new state.box2d.b2Filter(),
          (wasmFilter) => {
            // Public filters are 32-bit numbers; Box2D stores 64-bit masks. The
            // decimal string setters zero-pad the upper 32 bits explicitly.
            wasmFilter.setCategoryBits64(String(filter.categoryBits >>> 0));
            wasmFilter.setMaskBits64(String(filter.maskBits >>> 0));
            wasmFilter.groupIndex = filter.groupIndex;
            state.box2d.b2Shape_SetFilter(shapeId, wasmFilter);
          }
        );
      }
    });
  collisionFilterSystem.entity.add(PhysicsSystemTag);

  const sensorSystem = world
    .system("PhysicsMaterialFilterSync:Sensor")
    .with(Sensor, shapeWithBodyParent)
    .phase(phase)
    .update(Iter, Sensor, [Shape, { target: [ChildOf, [Body]] }], (it, _sensor, tuple) => {
      const [shape, body] = tuple;
      recreateShapeForEntity(state, it.entity, it.src[1], body, shape);
    });
  sensorSystem.entity.add(PhysicsSystemTag);
}

function requiresMaterialRecreate(
  state: PhysicsState,
  shape: Shape | undefined,
  next: Material
): boolean {
  if (shape === undefined || shape instanceof Chain) {
    return false;
  }

  const shapeId = shape._shapeId as b2ShapeId | undefined;
  if (shapeId === undefined || !state.box2d.b2Shape_IsValid(shapeId)) {
    return false;
  }

  const materialData = state.box2d.b2Shape_GetSurfaceMaterial(shapeId);
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
