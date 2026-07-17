import { CleanupPolicy, Relationship } from "../component_meta.js";
import type { ComponentInstance, ComponentMeta } from "../component_meta.js";
import { CommandKind } from "../command.js";
import { Components } from "./entity.components.js";
import type { Entity } from "./entity.js";

const enum DestructionFrameKind {
  Begin,
  Finish,
}

type AttachmentSnapshot = {
  meta: ComponentMeta;
  component: ComponentInstance;
};

type IncomingSnapshot = {
  source: Entity;
  meta: ComponentMeta;
  relationship: Relationship;
};

type DestructionFrame =
  | { kind: DestructionFrameKind.Begin; entity: Entity }
  | {
      kind: DestructionFrameKind.Finish;
      entity: Entity;
      attachments: AttachmentSnapshot[];
      incomingRemovals: IncomingSnapshot[];
    };

export class Lifecycle extends Components {
  /** @internal Apply a destroy request with an indexed, iterative cascade. */
  public _destroy(): void {
    const stack: DestructionFrame[] = [
      { kind: DestructionFrameKind.Begin, entity: this as unknown as Entity },
    ];
    const checkedAttachments = new Set<Entity>();

    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === DestructionFrameKind.Begin) {
        this._beginDestruction(frame.entity, stack, checkedAttachments);
      } else {
        this._finishDestruction(frame);
      }
    }
  }

  /**
   * Destroy this entity.
   *
   * Each component fires its `onRemove` hook, the entity is unregistered from
   * the world, and incoming relationship cleanup policies are applied. After
   * destruction the entity must not be used. Cleanup and callbacks are fail-fast:
   * an exception propagates from this call, or from the deferred synchronization
   * boundary applying it, and invalidates the current world without rollback.
   */
  public destroy(): void {
    if (this._destroyed) {
      return;
    }

    if (this.world.deferred) {
      this._assertDestructionIntegrity(new Set());
      this.world._enqueue({ kind: CommandKind.Destroy, entity: this as unknown as Entity });
    } else {
      this._destroy();
    }
  }

  private _beginDestruction(
    entity: Entity,
    stack: DestructionFrame[],
    checkedAttachments: Set<Entity>
  ): void {
    if (entity._destroyed) {
      return;
    }

    entity._assertDestructionIntegrity(checkedAttachments);

    const entityMeta = entity._meta;
    entity._destroyed = true;
    entityMeta?._retire();

    const carriers = entityMeta ? [...entityMeta._carriers()] : [];
    const attachments: AttachmentSnapshot[] = [];
    entity._components.forEach((component, ceid) => {
      const meta = entity._componentMetas.get(ceid);
      if (!meta) {
        throw new Error(`Cannot destroy entity ${entity.eid}; component ${ceid} has no owner`);
      }
      attachments.push({ meta, component });
    });
    const incoming = entity._snapshotIncoming();
    const incomingRemovals: IncomingSnapshot[] = [];
    const dependencies: Entity[] = [];

    if (entityMeta?.onDelete === CleanupPolicy.Throw) {
      for (const carrier of carriers) {
        if (carrier !== entity && !carrier._destroyed) {
          throw new Error(`Cannot destroy entity ${entity.eid}; component eid is still in use`);
        }
      }
    } else if (entityMeta?.onDelete === CleanupPolicy.Delete) {
      for (const carrier of carriers) {
        if (carrier !== entity) {
          dependencies.push(carrier);
        }
      }
    }
    for (const edge of incoming) {
      if (edge.meta.onDeleteTarget === CleanupPolicy.Delete) {
        dependencies.push(edge.source);
      } else if (edge.meta.onDeleteTarget === CleanupPolicy.Throw) {
        if (!edge.source._destroyed) {
          throw new Error(
            `Cannot destroy entity ${entity.eid}; relationship target is still in use`
          );
        }
      } else {
        incomingRemovals.push(edge);
      }
    }

    if (entityMeta?.onDelete === CleanupPolicy.Remove) {
      for (const carrier of carriers) {
        if (carrier !== entity) {
          carrier._removeForCleanup(entityMeta);
        }
      }
    }

    entity.world._notifyEntityDestroyed(entity);

    stack.push({
      kind: DestructionFrameKind.Finish,
      entity,
      attachments,
      incomingRemovals,
    });
    for (let i = dependencies.length - 1; i >= 0; i--) {
      stack.push({ kind: DestructionFrameKind.Begin, entity: dependencies[i] });
    }
  }

  private _finishDestruction(
    frame: Extract<DestructionFrame, { kind: DestructionFrameKind.Finish }>
  ): void {
    for (const { meta, component } of frame.attachments) {
      frame.entity._removeAttachmentUnchecked(meta, component);
    }
    frame.entity._finalizeDestroy();
    for (const { source, meta, relationship } of frame.incomingRemovals) {
      source._removeTargetForCleanup(meta, frame.entity, relationship);
    }
  }

  private _finalizeDestroy(): void {
    const entity = this as unknown as Entity;
    const entityMeta = this._meta;
    this._dirtyComponentBitmask.clear();
    this._queries.clear();
    this._components.clear();
    this._componentMetas.clear();
    this._incoming = undefined;
    if (
      entityMeta &&
      entityMeta.usageCount === 0 &&
      entityMeta.Class !== Object &&
      this.world._classRegistry.get(entityMeta.Class) === entity
    ) {
      this.world._classRegistry.delete(entityMeta.Class);
    }
    this.world._unregisterEntity(entity);
  }

  private _snapshotIncoming(): IncomingSnapshot[] {
    const target = this as unknown as Entity;
    const incoming: IncomingSnapshot[] = [];
    this._incoming?.forEach((generations, relEid) => {
      for (const [meta, sources] of generations) {
        if (meta.eid !== relEid || !meta.isRelationship) {
          throw new Error(
            `Cannot destroy entity ${this.eid}; incoming relationship ${relEid} has no owner`
          );
        }
        for (const source of [...sources]) {
          const relationship = source._get(relEid);
          if (
            source._componentMetas.get(relEid) !== meta ||
            !(relationship instanceof Relationship) ||
            !relationship._hasTarget(target)
          ) {
            throw new Error(
              `Cannot destroy entity ${this.eid}; incoming relationship ${relEid} is inconsistent`
            );
          }
          incoming.push({ source, meta, relationship });
        }
      }
    });
    return incoming;
  }

  private _assertDestructionIntegrity(checkedAttachments: Set<Entity>): void {
    this._assertNoInitializingAttachments(checkedAttachments);
    if (this._meta?._hasInitializingAttachments()) {
      throw new Error(
        `Cannot destroy entity ${this.eid}; its component eid has an initializing attachment`
      );
    }
    this._assertIncomingInitializationIntegrity(checkedAttachments);
  }

  private _assertNoInitializingAttachments(checkedAttachments: Set<Entity>): void {
    const entity = this as unknown as Entity;
    if (checkedAttachments.has(entity)) {
      return;
    }
    checkedAttachments.add(entity);
    this._componentMetas.forEach((meta) => {
      meta._assertCanDetach(entity);
    });
  }

  private _assertIncomingInitializationIntegrity(checkedAttachments: Set<Entity>): void {
    this._incoming?.forEach((generations, relEid) => {
      for (const [meta, sources] of generations) {
        for (const source of sources) {
          if (meta.onDeleteTarget === CleanupPolicy.Delete) {
            source._assertNoInitializingAttachments(checkedAttachments);
            continue;
          }
          const relationship = source._get(relEid);
          if (
            source._componentMetas.get(relEid) === meta &&
            relationship instanceof Relationship &&
            relationship._targetCount() === 1
          ) {
            meta._assertCanDetach(source);
          }
        }
      }
    });
  }
}
