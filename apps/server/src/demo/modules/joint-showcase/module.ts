import { Module, PRE_STORE, type Entity } from "@vworlds/vecs";
import {
  Container,
  DrawIn,
  FillStyle,
  Line,
  Offset,
  Position as RenderPosition,
  Rectangle,
  Rotation as RenderRotation,
  Size,
  Star,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import {
  Body,
  BodyType,
  Box,
  DistanceJoint,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLinearSpring,
  JointMotor,
  Material,
  Position as PhysicsPosition,
  RevoluteJoint,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { updateRenderPosition } from "../../math.js";

export class JointShowcaseModule extends Module {
  public init(): void {
    const world = this.world;

    world
      .system("DrawSpringLines")
      .with(Line, JointBodyA, JointBodyB, JointFrame, RenderPosition)
      .phase(PRE_STORE)
      .each([Line, RenderPosition, JointFrame], (entity, [line, renderPosition, frame]) => {
        const anchor = entity.target(JointBodyA);
        const bob = entity.target(JointBodyB);
        if (anchor === undefined || bob === undefined) {
          return;
        }
        const anchorPosition = anchor.get(RenderPosition);
        const anchorRotation = anchor.get(RenderRotation);
        const bobPosition = bob.get(RenderPosition);
        if (anchorPosition === undefined || bobPosition === undefined) {
          return;
        }
        const angle = anchorRotation?.angle ?? 0;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const cornerX = anchorPosition.x + frame.localAnchorA.x * cos - frame.localAnchorA.y * sin;
        const cornerY = anchorPosition.y + frame.localAnchorA.x * sin + frame.localAnchorA.y * cos;
        updateRenderPosition(entity, renderPosition, cornerX, cornerY);

        const x2 = bobPosition.x - cornerX;
        const y2 = bobPosition.y - cornerY;
        if (line.x1 !== 0 || line.y1 !== 0 || line.x2 !== x2 || line.y2 !== y2) {
          line.x1 = 0;
          line.y1 = 0;
          line.x2 = x2;
          line.y2 = y2;
          entity.modified(Line);
        }
      });

    createJointShowcase(world);
  }
}

function createJointShowcase(world: { entity(): Entity }): void {
  const spinnerCorner = { x: 0.25, y: 0.25 };
  const spinnerPos = { x: -3.4, y: 0.4 };
  const motorAnchor = world
    .entity()
    .set(PhysicsPosition, spinnerPos)
    .set(Body, { type: BodyType.Static });
  const spinner = world
    .entity()
    .add(Networked)
    .add(Rectangle)
    .set(Size, { width: 0.5, height: 0.5 })
    .set(FillStyle, { color: 0xffaa33, alpha: 1 })
    .set(RenderPosition, spinnerPos)
    .set(RenderRotation, { angle: 0 })
    .set(PhysicsPosition, spinnerPos)
    .set(PhysicsRotation, { angle: 0 })
    .set(Body, { type: BodyType.Dynamic });
  world.entity().childOf(spinner).set(Box, { hx: 0.25, hy: 0.25 }).set(Material, { density: 1 });
  world
    .entity()
    .set(JointBodyA, { target: motorAnchor })
    .set(JointBodyB, { target: spinner })
    .add(RevoluteJoint)
    .set(JointMotor, { targetSpeed: 2, maxForce: 80 });

  const bobStart = { x: spinnerPos.x, y: spinnerPos.y - 0.9 };
  const bob = world
    .entity()
    .add(Networked)
    .add(Container)
    .set(RenderPosition, bobStart)
    .set(RenderRotation, { angle: 0 })
    .set(PhysicsPosition, bobStart)
    .set(PhysicsRotation, { angle: 0 })
    .set(Body, { type: BodyType.Dynamic });
  world.entity().childOf(bob).set(Box, { hx: 0.2, hy: 0.2 }).set(Material, { density: 1 });

  // Bob visual: a display child Rectangle at local (0,0).
  // ChildOf the bob for lifecycle; DrawIn the bob for display.
  world
    .entity()
    .childOf(bob)
    .set(DrawIn, { target: bob })
    .add(Networked)
    .add(Rectangle)
    .set(Size, { width: 0.4, height: 0.4 })
    .set(FillStyle, { color: 0x66ffcc, alpha: 1 })
    .set(Offset, { x: 0, y: 0 });

  // A small star pinned to the top-right corner of the bob. The Offset is
  // fixed — it never changes — so the server sends it once. The client
  // composes the transform via the parent Container: as the bob swings and
  // rotates, the star follows for free (native parenting).
  world
    .entity()
    .childOf(bob)
    .set(DrawIn, { target: bob })
    .add(Networked)
    .set(Star, { innerRadius: 0.03, outerRadius: 0.06 })
    .set(FillStyle, { color: 0xffee55, alpha: 1 })
    .set(Offset, { x: 0.2, y: 0.2 });

  world
    .entity()
    .add(Networked)
    .set(JointBodyA, { target: spinner })
    .set(JointBodyB, { target: bob })
    .set(DistanceJoint, { length: 0.6 })
    .set(JointFrame, {
      localAnchorA: spinnerCorner,
      localAnchorB: { x: 0, y: 0 },
      referenceAngle: 0,
    })
    .set(JointLinearSpring, { hertz: 1.2, dampingRatio: 0.1 })
    .set(RenderPosition, { x: spinnerPos.x, y: spinnerPos.y })
    .set(Line, { x1: 0, y1: 0, x2: 0, y2: 0 })
    .set(StrokeStyle, { color: 0xffffff, alpha: 0.8, width: 2 });
}
