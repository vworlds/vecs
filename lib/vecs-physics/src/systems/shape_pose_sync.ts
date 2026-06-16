import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Chain, SingleShape } from "../components/geometry.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { recreateChainForEntity } from "./chain_lifecycle.js";
import { recreateSingleShapeForEntity } from "./shape_lifecycle.js";
import { chainWithBodyParent, singleShapeWithBodyParent } from "./shape_predicates.js";

export function installShapePoseSync(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsShapePoseSync:Position")
    .with(ShapePosition, singleShapeWithBodyParent)
    .phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.update(
    {
      watch: ShapePosition,
      enter: true,
      cursor: Iter,
      inject: [SingleShape, { target: [ChildOf, [Body]] }],
    },
    (it, _position, [shape, body]) => {
      recreateSingleShapeForEntity(engine, it.entity, it.src[1], body, shape);
    }
  );

  const chainPositionSystem = world
    .system("PhysicsShapePoseSync:ChainPosition")
    .with(ShapePosition, chainWithBodyParent)
    .phase(phase)
    .update(
      {
        watch: ShapePosition,
        enter: true,
        cursor: Iter,
        inject: [Chain, { target: [ChildOf, [Body]] }],
      },
      (it, _position, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    );
  chainPositionSystem.entity.add(PhysicsSystemTag);

  const rotationSystem = world
    .system("PhysicsShapePoseSync:Rotation")
    .with(ShapeRotation, singleShapeWithBodyParent)
    .phase(phase)
    .update(
      {
        watch: ShapeRotation,
        enter: true,
        cursor: Iter,
        inject: [SingleShape, { target: [ChildOf, [Body]] }],
      },
      (it, _rotation, [shape, body]) => {
        recreateSingleShapeForEntity(engine, it.entity, it.src[1], body, shape);
      }
    );
  rotationSystem.entity.add(PhysicsSystemTag);

  const chainRotationSystem = world
    .system("PhysicsShapePoseSync:ChainRotation")
    .with(ShapeRotation, chainWithBodyParent)
    .phase(phase)
    .update(
      {
        watch: ShapeRotation,
        enter: true,
        cursor: Iter,
        inject: [Chain, { target: [ChildOf, [Body]] }],
      },
      (it, _rotation, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    );
  chainRotationSystem.entity.add(PhysicsSystemTag);
}
