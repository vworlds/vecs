import {
  attachPhysics,
  getPhysics,
  hasPhysics,
  PhysicsState as EnginePhysicsState,
  PhysicsSystemTag,
  registerInternalComponents,
  type ResolvedPhysicsOptions,
} from "../engine/state.js";
import { type Box2DModule } from "./runtime.js";

export type EntityId = number;
export type b2WorldId = ReturnType<Box2DModule["b2CreateWorld"]>;
export type b2BodyId = ReturnType<Box2DModule["b2CreateBody"]>;
export type b2ShapeId = ReturnType<Box2DModule["b2CreateCircleShape"]>;
export type b2ChainId = ReturnType<Box2DModule["b2CreateChain"]>;
export { attachPhysics, getPhysics, hasPhysics, PhysicsSystemTag, registerInternalComponents };
export type { ResolvedPhysicsOptions };

export class PhysicsState extends EnginePhysicsState {
  public worldId!: b2WorldId;
  public readonly box2d: Box2DModule;
  public readonly bodyByEntityWasm = new Map<EntityId, b2BodyId>();
  public readonly entityByBody = new Map<b2BodyId, EntityId>();
  public readonly shapeByEntityWasm = new Map<EntityId, b2ShapeId>();
  public readonly entityByShape = new Map<b2ShapeId, EntityId>();
  public readonly chainByEntity = new Map<EntityId, b2ChainId>();
  public readonly options: ResolvedPhysicsOptions;
  public readonly pendingLinearImpulse = new Map<
    EntityId,
    { x: number; y: number; wake: boolean }
  >();
  public readonly pendingAngularImpulse = new Map<EntityId, { value: number; wake: boolean }>();

  public constructor(box2d: Box2DModule, options: ResolvedPhysicsOptions) {
    super(options);
    this.box2d = box2d;
    this.options = options;
  }
}
