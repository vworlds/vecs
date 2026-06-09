import { DependsOn, Entity, insertPhaseAfter, Phase, type System } from "@vworlds/vecs";
import { Position as RenderPosition, Rotation as RenderRotation } from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";
import { type ServerWorld } from "@vworlds/vecs-server";

export interface SyncPhysicsPoseOptions {
  phase?: Entity | string;
}

const DEFAULT_PHYSICS_POST_PHASE = "physics-post";
const DEFAULT_SYNC_PHASE = "phaser-pose-sync";

export function syncPhysicsPose(world: ServerWorld, options: SyncPhysicsPoseOptions = {}): System {
  return world
    .system("PhaserSyncPhysicsPose")
    .with(PhysicsPosition)
    .phase(resolvePhase(world, options.phase))
    .each(
      [PhysicsPosition, PhysicsRotation, RenderPosition, RenderRotation],
      (entity, components) => {
        const [physicsPosition, physicsRotation, renderPosition, renderRotation] = components;

        if (
          renderPosition === undefined ||
          renderPosition.x !== physicsPosition.x ||
          renderPosition.y !== physicsPosition.y
        ) {
          entity.set(RenderPosition, { x: physicsPosition.x, y: physicsPosition.y });
        }

        if (
          physicsRotation !== undefined &&
          (renderRotation === undefined || renderRotation.angle !== physicsRotation.angle)
        ) {
          entity.set(RenderRotation, { angle: physicsRotation.angle });
        }
      }
    );
}

function resolvePhase(world: ServerWorld, phase: Entity | string | undefined): Entity | string {
  if (phase !== undefined) {
    return phase;
  }

  const physicsPostPhase = world.entity(DEFAULT_PHYSICS_POST_PHASE).add(Phase);
  const syncPhase = world.entity(DEFAULT_SYNC_PHASE).add(Phase);
  if (syncPhase.get(DependsOn)?.target !== physicsPostPhase) {
    insertPhaseAfter(syncPhase, physicsPostPhase);
  }
  return syncPhase;
}
