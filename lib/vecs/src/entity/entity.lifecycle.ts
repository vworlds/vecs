import { CleanupPolicy, Relationship } from "../component_meta.js";
import type { ComponentInstance, ComponentMeta } from "../component_meta.js";
import { CommandKind } from "../command.js";
import { Components } from "./entity.components.js";
import type { Entity } from "./entity.js";

/** @internal Result of applying a queued or immediate destroy request. */
export const enum DestructionResult {
  Destroyed,
  AlreadyDestroyed,
  Blocked,
}

const enum DeletionOpKind {
  Destroy,
  RemoveAttachment,
  RemoveTarget,
  FinalizeDestroy,
}

type DestroyOp = { kind: DeletionOpKind.Destroy; entity: Entity };
type RemoveAttachmentOp = {
  kind: DeletionOpKind.RemoveAttachment;
  entity: Entity;
  meta: ComponentMeta;
  component: ComponentInstance;
  validate: boolean;
  cleanupOwner: Entity | undefined;
};
type RemoveTargetOp = {
  kind: DeletionOpKind.RemoveTarget;
  source: Entity;
  meta: ComponentMeta;
  target: Entity;
};
type FinalizeDestroyOp = { kind: DeletionOpKind.FinalizeDestroy; entity: Entity };
type DeletionOp = DestroyOp | RemoveAttachmentOp | RemoveTargetOp | FinalizeDestroyOp;

type DeletionPlan = {
  destroyOrder: Entity[];
  operations: DeletionOp[];
};

export class Lifecycle extends Components {
  /**
   * @internal Apply a `Destroy` command through a fully preflighted indexed plan.
   * Deferred conflicts return `Blocked`; immediate public destruction asks this
   * method to rethrow the preflight error instead.
   */
  public _destroy(throwOnBlocked = false): DestructionResult {
    if (this._destroyed) {
      return DestructionResult.AlreadyDestroyed;
    }

    let plan: DeletionPlan;
    try {
      plan = this._buildDeletionPlan();
    } catch (error) {
      if (throwOnBlocked) {
        throw error;
      }
      return DestructionResult.Blocked;
    }

    this._commitDeletionPlan(plan);
    return DestructionResult.Destroyed;
  }

  /**
   * Destroy this entity.
   *
   * Each component fires its `onRemove` hook, the entity is unregistered from
   * the world, and incoming relationship cleanup policies are applied. After
   * destruction the entity must not be used.
   */
  public destroy(): void {
    this.world._assertStructuralMutationAllowed();
    if (this._destroyed) {
      return;
    }

    // Constructor-time calls must fail synchronously so the surrounding add
    // transaction can roll back instead of enqueueing a later destroy.
    this._assertNoInitializingAttachments();
    this._assertIncomingInitializationIntegrity();
    const entityMeta = this._meta;
    if (entityMeta?._hasInitializingAttachments()) {
      throw new Error(
        `Cannot destroy entity ${this.eid}; its component eid has an initializing attachment`
      );
    }
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Destroy, entity: this as unknown as Entity });
    } else {
      this._destroy(true);
    }
  }

  /** Discover and validate the complete graph without framework-owned mutation. */
  private _buildDeletionPlan(): DeletionPlan {
    const root = this as unknown as Entity;
    const destroyOrder: Entity[] = [root];
    const destroyed = new Set<Entity>(destroyOrder);

    for (let i = 0; i < destroyOrder.length; i++) {
      const entity = destroyOrder[i];
      const entityMeta = entity._meta;
      if (entityMeta) {
        for (const carrier of entityMeta._carriers()) {
          if (carrier === entity) {
            continue;
          }
          if (entityMeta.onDelete === CleanupPolicy.Delete && !destroyed.has(carrier)) {
            destroyed.add(carrier);
            destroyOrder.push(carrier);
          }
        }
      }

      entity._incoming?.forEach((sources, relEid) => {
        const relationshipMeta = entity.world.getEntity(relEid)?.meta;
        if (relationshipMeta?.onDeleteTarget !== CleanupPolicy.Delete) {
          return;
        }
        for (const source of sources) {
          if (!destroyed.has(source)) {
            destroyed.add(source);
            destroyOrder.push(source);
          }
        }
      });
    }

    for (const entity of destroyOrder) {
      const entityMeta = entity._meta;
      if (entityMeta?.onDelete !== CleanupPolicy.Throw) {
        continue;
      }
      for (const carrier of entityMeta._carriers()) {
        if (carrier !== entity && !destroyed.has(carrier)) {
          throw new Error(`Cannot destroy entity ${entity.eid}; component eid is still in use`);
        }
      }
    }

    const attachmentOps = new Map<Entity, Map<ComponentMeta, RemoveAttachmentOp>>();
    const edgeOps = new Map<Entity, Map<ComponentMeta, Map<Entity, RemoveTargetOp>>>();

    const addAttachment = (
      entity: Entity,
      meta: ComponentMeta,
      component: ComponentInstance,
      validate: boolean,
      cleanupOwner?: Entity
    ): RemoveAttachmentOp => {
      let byMeta = attachmentOps.get(entity);
      if (!byMeta) {
        byMeta = new Map();
        attachmentOps.set(entity, byMeta);
      }
      const existing = byMeta.get(meta);
      if (existing) {
        existing.validate ||= validate;
        existing.cleanupOwner ??= cleanupOwner;
        return existing;
      }
      const operation: RemoveAttachmentOp = {
        kind: DeletionOpKind.RemoveAttachment,
        entity,
        meta,
        component,
        validate,
        cleanupOwner,
      };
      byMeta.set(meta, operation);
      return operation;
    };

    const addAttachmentWithAliases = (
      entity: Entity,
      meta: ComponentMeta,
      validate: boolean,
      cleanupOwner: Entity
    ): void => {
      const component = entity._get(meta.eid);
      if (!component) {
        return;
      }
      for (const aliasMeta of meta._implementsClosure ?? []) {
        if (entity._get(aliasMeta.eid) === component) {
          addAttachment(entity, aliasMeta, component, false, cleanupOwner);
        }
      }
      addAttachment(entity, meta, component, validate, cleanupOwner);
    };

    for (const entity of destroyOrder) {
      const entityMeta = entity._meta;
      if (entityMeta?.onDelete === CleanupPolicy.Remove) {
        for (const carrier of entityMeta._carriers()) {
          if (carrier !== entity && !destroyed.has(carrier)) {
            addAttachmentWithAliases(carrier, entityMeta, true, entity);
          }
        }
      }

      entity._incoming?.forEach((sources, relEid) => {
        const relationshipMeta = entity.world.getEntity(relEid)?.meta;
        if (!relationshipMeta || relationshipMeta.onDeleteTarget !== CleanupPolicy.Remove) {
          return;
        }
        for (const source of sources) {
          if (destroyed.has(source)) {
            continue;
          }
          const relationship = source._get(relEid) as Relationship | undefined;
          if (!relationship?._hasTarget(entity)) {
            continue;
          }
          let byMeta = edgeOps.get(source);
          if (!byMeta) {
            byMeta = new Map();
            edgeOps.set(source, byMeta);
          }
          let byTarget = byMeta.get(relationshipMeta);
          if (!byTarget) {
            byTarget = new Map();
            byMeta.set(relationshipMeta, byTarget);
          }
          if (!byTarget.has(entity)) {
            byTarget.set(entity, {
              kind: DeletionOpKind.RemoveTarget,
              source,
              meta: relationshipMeta,
              target: entity,
            });
          }
        }
      });
    }

    edgeOps.forEach((byMeta, source) => {
      const removedAttachments = attachmentOps.get(source);
      if (!removedAttachments) {
        return;
      }
      for (const meta of removedAttachments.keys()) {
        byMeta.delete(meta);
      }
    });

    for (const entity of destroyOrder) {
      entity._components.forEach((component, ceid) => {
        const componentMeta = entity.world.getEntity(ceid)?.meta;
        if (!componentMeta) {
          throw new Error(`Cannot destroy entity ${entity.eid}; component ${ceid} is unregistered`);
        }
        addAttachment(entity, componentMeta, component, false);
      });
    }

    // Initialization guards and validators are intentionally a separate pass:
    // every callback succeeds before the first framework-owned mutation begins.
    for (const entity of destroyOrder) {
      entity._components.forEach((_component, ceid) => {
        entity.world.getEntity(ceid)?.meta._assertCanDetach(entity);
      });
    }
    const validatedAttachments = new Map<Entity, Set<ComponentMeta>>();
    attachmentOps.forEach((byMeta, entity) => {
      byMeta.forEach((operation) => {
        operation.meta._assertCanDetach(entity);
        if (operation.validate) {
          if (operation.meta._validateRemove) {
            entity.world._runDeletionPreflight(() => operation.meta._validateRemove!(entity));
          }
          let metas = validatedAttachments.get(entity);
          if (!metas) {
            metas = new Set();
            validatedAttachments.set(entity, metas);
          }
          metas.add(operation.meta);
        }
      });
    });
    edgeOps.forEach((byMeta, source) => {
      byMeta.forEach((byTarget, meta) => {
        meta._assertCanDetach(source);
        const relationship = source._get(meta.eid) as Relationship | undefined;
        if (
          relationship &&
          relationship._targetArray().every((target) => byTarget.has(target)) &&
          !validatedAttachments.get(source)?.has(meta)
        ) {
          if (meta._validateRemove) {
            source.world._runDeletionPreflight(() => meta._validateRemove!(source));
          }
        }
      });
    });

    const cleanupByOwner = new Map<Entity, RemoveAttachmentOp[]>();
    const ownByEntity = new Map<Entity, RemoveAttachmentOp[]>();
    attachmentOps.forEach((byMeta, entity) => {
      byMeta.forEach((operation) => {
        if (operation.cleanupOwner) {
          let cleanup = cleanupByOwner.get(operation.cleanupOwner);
          if (!cleanup) {
            cleanup = [];
            cleanupByOwner.set(operation.cleanupOwner, cleanup);
          }
          cleanup.push(operation);
        } else if (destroyed.has(entity)) {
          let own = ownByEntity.get(entity);
          if (!own) {
            own = [];
            ownByEntity.set(entity, own);
          }
          own.push(operation);
        }
      });
    });
    const edgesByTarget = new Map<Entity, RemoveTargetOp[]>();
    edgeOps.forEach((byMeta) =>
      byMeta.forEach((byTarget) =>
        byTarget.forEach((operation) => {
          let edges = edgesByTarget.get(operation.target);
          if (!edges) {
            edges = [];
            edgesByTarget.set(operation.target, edges);
          }
          edges.push(operation);
        })
      )
    );
    const operations: DeletionOp[] = [];
    for (const entity of destroyOrder) {
      operations.push(...(cleanupByOwner.get(entity) ?? []));
      operations.push({ kind: DeletionOpKind.Destroy, entity });
      operations.push(...(ownByEntity.get(entity) ?? []));
      operations.push({ kind: DeletionOpKind.FinalizeDestroy, entity });
      operations.push(...(edgesByTarget.get(entity) ?? []));
    }

    return { destroyOrder, operations };
  }

  /** Execute only the frozen operations; dependency discovery and validation are forbidden here. */
  private _commitDeletionPlan(plan: DeletionPlan): void {
    let firstError: unknown;
    // Freeze the complete accepted snapshot before any observer can re-enter.
    for (const entity of plan.destroyOrder) {
      entity._destroyed = true;
      entity._meta?._retire();
    }
    for (const operation of plan.operations) {
      try {
        switch (operation.kind) {
          case DeletionOpKind.Destroy:
            operation.entity.world._notifyEntityDestroyed(operation.entity);
            break;
          case DeletionOpKind.RemoveAttachment:
            operation.entity._removeAttachmentUnchecked(operation.meta, operation.component);
            break;
          case DeletionOpKind.RemoveTarget:
            operation.source._removeTargetUnchecked(operation.meta, operation.target);
            break;
          case DeletionOpKind.FinalizeDestroy:
            operation.entity._finalizeDestroy();
            break;
        }
      } catch (error) {
        firstError ??= error;
      }
    }

    // User hooks and Exit callbacks run during commit. A callback failure is
    // reported only after every mandatory planned teardown operation has run,
    // preventing authoritative attachments or reverse edges from being stranded.
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /** Finish a planned entity destruction after all attachment and edge operations. */
  private _finalizeDestroy(): void {
    const entity = this as unknown as Entity;
    const entityMeta = this._meta;
    this._dirtyComponentBitmask.clear();
    this._queries.clear();
    this._components.clear();
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

  private _assertNoInitializingAttachments(): void {
    const entity = this as unknown as Entity;
    this._components.forEach((_component, ceid) => {
      this.world.getEntity(ceid)?.meta._assertCanDetach(entity);
    });
  }

  private _assertIncomingInitializationIntegrity(): void {
    this._incoming?.forEach((sources, relEid) => {
      const relationshipMeta = this.world.getEntity(relEid)?.meta;
      if (!relationshipMeta) {
        return;
      }
      for (const source of sources) {
        if (relationshipMeta.onDeleteTarget === CleanupPolicy.Delete) {
          source._assertNoInitializingAttachments();
          continue;
        }
        const relationship = source._get(relEid) as Relationship | undefined;
        if (relationship?._targetCount() === 1) {
          relationshipMeta._assertCanDetach(source);
        }
      }
    });
  }
}
