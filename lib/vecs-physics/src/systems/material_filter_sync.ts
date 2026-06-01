import { type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { withAllocated } from "../adapter/disposal.js";
import { type PhysicsState } from "../adapter/state.js";
import type { InternalShape } from "../engine/shape.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";

export function installMaterialFilterSync(
  world: World,
  state: PhysicsState,
  phase: IPhase
): System {
  const system = world
    .system("PhysicsMaterialFilterSync")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  system.update(Material, (entity, material) => {
    const previousMaterial = readLegacyMaterial(state, entity);
    if (previousMaterial !== undefined && requiresMaterialRecreate(previousMaterial, material)) {
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

    applyLegacyMaterial(state, entity, material);
  });

  system.update(CollisionFilter, (entity, filter) => {
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

    applyLegacyFilter(state, entity, filter);
  });

  system.update(Sensor, (entity) => {
    recreateShapeForEntity(state, entity);
  });

  return system;
}

function readLegacyMaterial(state: PhysicsState, entity: Entity): MaterialSnapshot | undefined {
  const handle = state.shapeByEntity.get(entity.eid);
  if (handle !== undefined) {
    const shape = state.shapes.get(handle.index) as InternalShape;
    return snapshotMaterial(shape);
  }

  const chainHandles = state.chainShapeByEntity.get(entity.eid);
  const firstChainHandle = chainHandles?.[0];
  if (firstChainHandle !== undefined) {
    const shape = state.shapes.get(firstChainHandle.index) as InternalShape;
    return snapshotMaterial(shape);
  }

  return undefined;
}

function requiresMaterialRecreate(previous: MaterialSnapshot, next: Material): boolean {
  return (
    previous.rollingResistance !== next.rollingResistance ||
    previous.tangentSpeed !== next.tangentSpeed ||
    previous.userMaterialId !== next.userMaterialId
  );
}

function applyLegacyMaterial(state: PhysicsState, entity: Entity, material: Material): void {
  const handle = state.shapeByEntity.get(entity.eid);
  if (handle !== undefined) {
    applyMaterialToShape(state.shapes.get(handle.index) as InternalShape, material);
  }

  const chainHandles = state.chainShapeByEntity.get(entity.eid);
  if (chainHandles !== undefined) {
    for (const chainHandle of chainHandles) {
      applyMaterialToShape(state.shapes.get(chainHandle.index) as InternalShape, material);
    }
  }
}

function applyLegacyFilter(state: PhysicsState, entity: Entity, filter: CollisionFilter): void {
  const handle = state.shapeByEntity.get(entity.eid);
  if (handle !== undefined) {
    applyFilterToShape(state.shapes.get(handle.index) as InternalShape, filter);
  }

  const chainHandles = state.chainShapeByEntity.get(entity.eid);
  if (chainHandles !== undefined) {
    for (const chainHandle of chainHandles) {
      applyFilterToShape(state.shapes.get(chainHandle.index) as InternalShape, filter);
    }
  }
}

function applyMaterialToShape(shape: InternalShape, material: Material): void {
  shape.density = material.density;
  shape.friction = material.friction;
  shape.restitution = material.restitution;
  shape.rollingResistance = material.rollingResistance;
  shape.tangentSpeed = material.tangentSpeed;
  shape.userMaterialId = material.userMaterialId;
}

function applyFilterToShape(shape: InternalShape, filter: CollisionFilter): void {
  shape.categoryBits = filter.categoryBits;
  shape.maskBits = filter.maskBits;
  shape.groupIndex = filter.groupIndex;
}

function snapshotMaterial(shape: InternalShape): MaterialSnapshot {
  return {
    rollingResistance: shape.rollingResistance,
    tangentSpeed: shape.tangentSpeed,
    userMaterialId: shape.userMaterialId,
  };
}

interface MaterialSnapshot {
  rollingResistance: number;
  tangentSpeed: number;
  userMaterialId: number;
}
