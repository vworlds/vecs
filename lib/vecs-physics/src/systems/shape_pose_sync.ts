import { type Entity, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type PhysicsState } from "../adapter/state.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";

export function installShapePoseSync(world: World, state: PhysicsState, phase: Entity): System {
  const shapePredicate = {
    all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }],
  } as const;
  const system = world
    .system("PhysicsShapePoseSync:Position")
    .with(ShapePosition, shapePredicate)
    .phase(phase);

  system.update(ShapePosition, (entity) => {
    recreateShapeForEntity(state, entity);
  });

  world
    .system("PhysicsShapePoseSync:Rotation")
    .with(ShapeRotation, shapePredicate)
    .phase(phase)
    .update(ShapeRotation, (entity) => {
      recreateShapeForEntity(state, entity);
    });

  return system;
}
