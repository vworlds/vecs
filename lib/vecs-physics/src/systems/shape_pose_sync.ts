import { type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type PhysicsState } from "../adapter/state.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";

export function installShapePoseSync(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world
    .system("PhysicsShapePoseSync")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  system.update(ShapePosition, (entity) => {
    recreateShapeForEntity(state, entity);
  });

  system.update(ShapeRotation, (entity) => {
    recreateShapeForEntity(state, entity);
  });

  return system;
}
