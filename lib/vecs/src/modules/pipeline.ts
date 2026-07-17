import { System } from "../system.js";
import { Module } from "../module.js";
import { type Entity } from "../entity/index.js";
import { DependsOn } from "./relationships.js";

/** Marker component tagging an entity as a pipeline phase anchor. */
export class Phase {}

export const ON_LOAD = "vecs::OnLoad";
export const POST_LOAD = "vecs::PostLoad";
export const PRE_UPDATE = "vecs::PreUpdate";
export const ON_UPDATE = "vecs::OnUpdate";
export const ON_VALIDATE = "vecs::OnValidate";
export const POST_UPDATE = "vecs::PostUpdate";
export const PRE_STORE = "vecs::PreStore";
export const ON_STORE = "vecs::OnStore";

export const BUILTIN_PIPELINE_PHASES = [
  ON_LOAD,
  POST_LOAD,
  PRE_UPDATE,
  ON_UPDATE,
  ON_VALIDATE,
  POST_UPDATE,
  PRE_STORE,
  ON_STORE,
] as const;

/** Insert an existing phase directly after an existing phase spine anchor. */
export function insertPhaseAfter(phase: Entity, anchor: Entity): Entity {
  assertPhase(phase, "phase");
  assertPhase(anchor, "anchor");

  const downstream = [...anchor.children(DependsOn)].filter(
    (child) => child !== phase && child.has(Phase) && child.has(DependsOn)
  );

  phase.add(DependsOn, anchor);

  for (const child of downstream) {
    child.add(DependsOn, phase);
  }

  return phase;
}

function assertPhase(entity: Entity, label: string): void {
  if (!entity.has(Phase)) {
    throw new Error(`insertPhaseAfter ${label} must have Phase`);
  }
}

/** Built-in module that creates the default query-driven system pipeline. */
export class PipelineModule extends Module {
  public init(): void {
    const world = this.world;
    world.component(Phase);
    world.component(DependsOn);

    const phases = BUILTIN_PIPELINE_PHASES.map((name) => world.entity(name).add(Phase));
    for (let i = 1; i < phases.length; i++) {
      phases[i].add(DependsOn, phases[i - 1]);
    }

    world.setPipeline({
      with: { all: [System, { target: [DependsOn, Phase] }] },
      cascade: DependsOn,
    });
  }
}
