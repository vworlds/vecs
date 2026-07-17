import { ChildOf, Iter, Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Chain, SingleShape } from "./components.js";
import { ShapePosition, ShapeRotation } from "./pose_components.js";
import { PhysicsCoreModule } from "../core/module.js";
import { recreateChainForEntity } from "./chain.js";
import { recreateSingleShapeForEntity } from "./lifecycle.js";
import { chainWithBodyParent, singleShapeWithBodyParent } from "./predicates.js";

export class ShapePoseModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsShapePoseSync:Position")
      .with(ShapePosition, singleShapeWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: ShapePosition,
          onEnter: true,
          cursor: Iter,
          inject: [SingleShape, { target: [ChildOf, [Body]] }],
        },
        (it, _position, [shape, body]) => {
          recreateSingleShapeForEntity(engine, it.entity, it.entity.target(ChildOf), body, shape);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsShapePoseSync:ChainPosition")
      .with(ShapePosition, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: ShapePosition,
          onEnter: true,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _position, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsShapePoseSync:Rotation")
      .with(ShapeRotation, singleShapeWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: ShapeRotation,
          onEnter: true,
          cursor: Iter,
          inject: [SingleShape, { target: [ChildOf, [Body]] }],
        },
        (it, _rotation, [shape, body]) => {
          recreateSingleShapeForEntity(engine, it.entity, it.entity.target(ChildOf), body, shape);
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsShapePoseSync:ChainRotation")
      .with(ShapeRotation, chainWithBodyParent)
      .phase(phase)
      .update(
        {
          watch: ShapeRotation,
          onEnter: true,
          cursor: Iter,
          inject: [Chain, { target: [ChildOf, [Body]] }],
        },
        (it, _rotation, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .add(PhysicsSystemTag);
  }
}
