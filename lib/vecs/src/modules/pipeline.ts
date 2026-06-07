import { System } from "../system.js";
import { Module } from "../module.js";
import { DependsOn, Traversable } from "./relationships.js";

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

/** Built-in module that creates the default query-driven system pipeline. */
export class PipelineModule extends Module {
  public init(): void {
    const world = this.world;
    world.component(Phase);
    world.component(DependsOn).add(Traversable);

    const phases = BUILTIN_PIPELINE_PHASES.map((name) => world.entity(name).add(Phase));
    for (let i = 1; i < phases.length; i++) {
      phases[i].set(DependsOn, { target: phases[i - 1] });
    }

    world.setPipeline({
      with: { all: [System, { target: [DependsOn, Phase] }] },
      cascade: DependsOn,
    });
  }
}
