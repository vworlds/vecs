export { System, type SystemCallbackKind, type SystemQuery } from "./system.js";
export type { Vec2 } from "./geometry.js";
export { Query, GroupedQuery, Group } from "./query/index.js";
export type { EntityTestFunc, MaybeRequired, QueryDSL } from "./dsl.js";
export { Delta, Iter, Now } from "./inject.js";
export type {
  ClockInject,
  ComponentInjectElement,
  ComponentInjectTuple,
  ComponentFanInjectTuple,
  DownInject,
  FanInjectElement,
  FanInjectTuple,
  InjectElement,
  InjectTuple,
  MaybeResolvedInjectTuple,
  RequiredResolvedInjectTuple,
  ResolvedTargets,
  ResolvedTargetsRow,
  TargetInject,
  TargetInjectProjection,
  TargetsInject,
} from "./inject.js";
export { DEFAULT_POOLS, World, type WorldOptions } from "./world/index.js";
export { WorldStats, type Timing, type SystemTiming, type OperationTiming } from "./world/stats.js";
export { Filter } from "./filter.js";
export { ComponentDef, Trait } from "./component_def.js";
export {
  ChildOf,
  DependsOn,
  Exclusive,
  OneOf,
  OwnedTarget,
  SilenceSource,
} from "./modules/relationships.js";
export {
  CleanupPolicy,
  Component,
  Implements,
  Relationship,
  type ComponentInstance,
  type ComponentClass,
  type ComponentMeta,
  type ComponentRef,
  type CustomSnapshotOptions,
  type HookEvent,
  type HookEventMap,
  type HookHandler,
  type NormalizeHandler,
  type TargetHandler,
  type ValidateHandler,
} from "./component.js";
export { VecsStruct } from "./reflection/vecs_struct.js";
export {
  description,
  range,
  type,
  unit,
  values,
  type MemberDecorator,
} from "./reflection/decorators.js";
export type {
  MemberClass,
  MemberElementType,
  MemberScalarType,
  MemberType,
  RangeBound,
  VecsMember,
} from "./reflection/member_types.js";
export type { ValidationResult, Violations } from "./reflection/defaults.js";
export { Entity, type EID, type EntityClass, Identity } from "./entity/index.js";
export { Module, type ModuleConfig } from "./module.js";
export { MoveSubtreeError } from "./world/world.transfers.js";
export { IdentityModule } from "./modules/identity.js";
export { ImplementsModule } from "./modules/implements.js";
export { Singleton, SingletonModule } from "./modules/singleton.js";
export { Traversable, With, RelationshipsModule } from "./modules/relationships.js";
export {
  type SnapshotCapture,
  type SnapshotMaterialize,
  ClonePublic,
  CustomSnapshot,
  DontSnapshot,
  OnSnapshot,
  SnapshotModule,
} from "./modules/snapshot.js";
export {
  type ComponentSnapshot,
  type EntitySubtreeSnapshot,
  type ExternalTargetPolicy,
  type MoveSubtreeResult,
  type RelationshipSnapshot,
  type RelationshipType,
  type RestoreSubtreeResult,
  type SubtreeEntitySnapshot,
  type SubtreeSnapshotOptions,
} from "./snapshot/types.js";
export {
  BUILTIN_PIPELINE_PHASES,
  insertPhaseAfter,
  ON_LOAD,
  ON_STORE,
  ON_UPDATE,
  ON_VALIDATE,
  POST_LOAD,
  POST_UPDATE,
  PRE_STORE,
  PRE_UPDATE,
  Phase,
  PipelineModule,
} from "./modules/pipeline.js";
export { getDSLKey, fnv1a32 } from "./dsl.js";
export { Term, TermEventKind, type TermConsumer } from "./terms/term.js";
export {
  ALWAYS_TICK_SOURCE,
  AlwaysTickSource,
  IntervalTickSource,
  RateTickSource,
  type ITickSource,
} from "./timer.js";
export { ArrayMap, IterableArrayMap } from "./util/array_map.js";
export { Bitset } from "./util/bitset.js";
export { Events, type EventListener, type EventNames } from "./util/events.js";
export { DEFAULT_ID_REUSE_WAIT_FRAMES, type IdPoolConfig } from "./util/id_pool.js";
