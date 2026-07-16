import { DependsOn, Phase, type Entity, type World } from "../src/index.js";

export function makePhase(world: World, name: string, dependsOn?: Entity): Entity {
  const phase = world.entity(name).add(Phase);
  if (dependsOn) {
    phase.add(DependsOn, dependsOn);
  }
  return phase;
}
