import { type Entity, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { withAllocated } from "../adapter/disposal.js";
import { type PhysicsState } from "../adapter/state.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";

export function installMaterialFilterSync(
  world: World,
  state: PhysicsState,
  phase: Entity
): System {
  const shapePredicate = {
    all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }],
  } as const;
  const system = world
    .system("PhysicsMaterialFilterSync:Material")
    .with(Material, shapePredicate)
    .phase(phase);

  system.update(Material, (entity, material) => {
    if (requiresMaterialRecreate(state, entity, material)) {
      // box2d3-wasm@5.2.0 exposes no shape setters for rollingResistance,
      // tangentSpeed, or userMaterialId, so those updates recreate the shape.
      recreateShapeForEntity(state, entity);
      return;
    }

    const shapeId = state.shapeByEntityWasm.get(entity.eid);
    if (shapeId !== undefined) {
      state.box2d.b2Shape_SetDensity(shapeId, material.density, true);
      state.box2d.b2Shape_SetFriction(shapeId, material.friction);
      state.box2d.b2Shape_SetRestitution(shapeId, material.restitution);
    }
    if (state.chainByEntity.has(entity.eid)) {
      recreateShapeForEntity(state, entity);
    }
  });

  world
    .system("PhysicsMaterialFilterSync:CollisionFilter")
    .with(CollisionFilter, shapePredicate)
    .phase(phase)
    .update(CollisionFilter, (entity, filter) => {
      const shapeId = state.shapeByEntityWasm.get(entity.eid);
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
      if (state.chainByEntity.has(entity.eid)) {
        recreateShapeForEntity(state, entity);
      }
    });

  world
    .system("PhysicsMaterialFilterSync:Sensor")
    .with(Sensor, shapePredicate)
    .phase(phase)
    .update(Sensor, (entity) => {
      recreateShapeForEntity(state, entity);
    });

  return system;
}

function requiresMaterialRecreate(state: PhysicsState, entity: Entity, next: Material): boolean {
  const shapeId = state.shapeByEntityWasm.get(entity.eid);
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
