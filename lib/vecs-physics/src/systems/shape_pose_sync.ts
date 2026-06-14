import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Shape } from "../components/geometry.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { recreateShapeForEntity } from "./shape_lifecycle.js";
import { shapeWithBodyParent } from "./shape_predicates.js";

export function installShapePoseSync(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsShapePoseSync:Position")
    .with(ShapePosition, shapeWithBodyParent)
    .phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.update(
    Iter,
    ShapePosition,
    [Shape, { target: [ChildOf, [Body]] }],
    (it, _position, tuple) => {
      const [shape, body] = tuple;
      recreateShapeForEntity(engine, it.entity, it.src[1], body, shape);
    }
  );

  const rotationSystem = world
    .system("PhysicsShapePoseSync:Rotation")
    .with(ShapeRotation, shapeWithBodyParent)
    .phase(phase)
    .update(Iter, ShapeRotation, [Shape, { target: [ChildOf, [Body]] }], (it, _rotation, tuple) => {
      const [shape, body] = tuple;
      recreateShapeForEntity(engine, it.entity, it.src[1], body, shape);
    });
  rotationSystem.entity.add(PhysicsSystemTag);
}
