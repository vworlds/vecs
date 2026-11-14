import { CommandKind } from "../command.js";
import type { ComponentInstance } from "../component.js";
import type { ComponentMeta } from "../component_meta.js";
import type { Entity } from "../entity/entity.js";
import { Queries } from "./world.queries.js";

export class Deferred extends Queries {
  /** @internal Parallel slots retain capacity across drains, but not referenced values. */
  protected _commandKinds: CommandKind[] = [];
  protected _commandEntities: (Entity | undefined)[] = [];
  protected _commandMetas: (ComponentMeta | undefined)[] = [];
  protected _commandPayloads: (
    Partial<ComponentInstance> | Entity | ((entity: Entity) => void) | undefined
  )[] = [];
  /** @internal Producer captured at enqueue time for `ignoreSource` routing. */
  protected _commandSources: (Entity | undefined)[] = [];
  protected _commandLength = 0;
  /** @internal Nested {@link beginDefer} / {@link endDefer} count. */
  protected _deferredDepth = 0;
  /** @internal `true` while {@link _processCommandQueue} is iterating, to avoid re-entrant drains. */
  protected _draining = false;
  /**
   * @internal Index of the first command slot not yet taken
   * by the drain: `0` outside a drain, one past the executing command during it.
   */
  protected _commandHead = 0;

  /**
   * @internal Buffered cleanup actions scheduled by `Entity._cleanupIncoming`.
   *
   * `undefined` outside an active `_destroy` cascade. The outermost `_destroy`
   * call lazily allocates the scope, recursive `_destroy` calls append to the
   * same scope, and the outermost call drains it to empty before returning.
   * Set back to `undefined` during each flush pass so recursive destroys
   * triggered by the flush buffer into a fresh scope and are drained by the
   * outer `while` loop.
   */
  public _deletionScope: unknown[] | undefined = undefined;

  /** @internal Reused entity/meta/source triples avoid allocating relationship commands. */
  private readonly _relationshipUpdates: (Entity | ComponentMeta | undefined)[] = [];
  private _relationshipUpdateLength = 0;

  /** `true` while the world is in deferred mode. */
  public get deferred(): boolean {
    return this._deferredDepth > 0 || this._draining;
  }

  /**
   * @internal Replay `entity`'s not-yet-applied edge commands for `meta` over
   * its committed `targets` snapshot, for `targets(R, { pending: true })`.
   */
  public _pendingTargets(
    entity: Entity,
    meta: ComponentMeta,
    targets: Entity[]
  ): readonly Entity[] {
    if (entity.destroyed) {
      return [];
    }
    for (let i = this._commandHead; i < this._commandLength; i++) {
      if (!this._isEdgeCommandFor(i, entity, meta)) {
        continue;
      }
      const kind = this._commandKinds[i];
      const target = this._commandPayloads[i] as Entity;
      if (kind === CommandKind.Remove) {
        targets.length = 0;
      } else if (kind === CommandKind.RemoveTarget) {
        const index = targets.indexOf(target);
        if (index !== -1) {
          targets.splice(index, 1);
        }
      } else if (!target.destroyed && !targets.includes(target)) {
        if (meta.relationshipExclusive) {
          targets.length = 0;
        }
        targets.push(target);
      }
    }
    return targets.some((target) => target.destroyed)
      ? targets.filter((target) => !target.destroyed)
      : targets;
  }

  /**
   * @internal Answer `hasTarget(R, target, { pending: true })` from the newest
   * not-yet-applied edge command of `entity` that decides `target`, else `committed`.
   */
  public _hasPendingTarget(
    entity: Entity,
    meta: ComponentMeta,
    target: Entity,
    committed: boolean
  ): boolean {
    if (entity.destroyed || target.destroyed) {
      return false;
    }
    for (let i = this._commandLength - 1; i >= this._commandHead; i--) {
      if (!this._isEdgeCommandFor(i, entity, meta)) {
        continue;
      }
      const kind = this._commandKinds[i];
      const pendingTarget = this._commandPayloads[i] as Entity;
      if (kind === CommandKind.Remove) {
        return false;
      }
      if (pendingTarget === target) {
        return kind === CommandKind.AddTarget;
      }
      if (
        kind === CommandKind.AddTarget &&
        meta.relationshipExclusive &&
        !pendingTarget.destroyed
      ) {
        return false;
      }
    }
    return committed;
  }

  /** @internal Append a command to the deferred-mode queue. */
  public _enqueue(
    kind: CommandKind,
    entity: Entity,
    meta?: ComponentMeta,
    payload?: Partial<ComponentInstance> | Entity | ((entity: Entity) => void)
  ): void {
    const index = this._commandLength++;
    this._commandKinds[index] = kind;
    this._commandEntities[index] = entity;
    this._commandMetas[index] = meta;
    this._commandPayloads[index] = payload;
    this._commandSources[index] = this._currentSource;
  }

  /** @internal Buffer one dirty relationship's notification with its original producer. */
  public _enqueueRelationshipUpdate(entity: Entity, meta: ComponentMeta, source?: Entity): void {
    const index = this._relationshipUpdateLength;
    this._relationshipUpdates[index] = entity;
    this._relationshipUpdates[index + 1] = meta;
    this._relationshipUpdates[index + 2] = source;
    this._relationshipUpdateLength += 3;
  }

  /** Enter deferred mode. */
  public beginDefer(): void {
    this._deferredDepth++;
  }

  /** Run `fn` inside a deferred scope. */
  public defer(fn: () => void): void {
    this.beginDefer();
    try {
      fn();
    } finally {
      this.endDefer();
    }
  }

  /** Leave deferred mode and drain at the outermost scope. */
  public endDefer(): void {
    this._deferredDepth--;
    this.flush();
  }

  /** Build pending queries and drain queued commands at the top level. */
  public flush(): void {
    if (this._deferredDepth === 0) {
      this._buildPendingQueries();
      this._processCommandQueue();
    }
  }

  /** @internal Run one command's side effects. */
  protected _executeCommand(index: number): void {
    const entity = this._commandEntities[index]!;
    const meta = this._commandMetas[index]!;
    const payload = this._commandPayloads[index];
    this._routingSource = this._commandSources[index];
    switch (this._commandKinds[index]) {
      case CommandKind.CreateEntity:
        this._entities.set(entity.eid, entity);
        this._deferredEntities.delete(entity.eid);
        this._notifyEntityCreated(entity);
        (payload as ((entity: Entity) => void) | undefined)?.(entity);
        return;
      case CommandKind.Set:
        entity._set(meta, payload as Partial<ComponentInstance> | undefined);
        return;
      case CommandKind.Assign:
        entity._assign(meta, payload as Partial<ComponentInstance>);
        return;
      case CommandKind.Modified:
        entity._modified(meta);
        return;
      case CommandKind.Remove:
        entity._remove(meta);
        return;
      case CommandKind.Destroy:
        entity._destroy();
        return;
      case CommandKind.Attach:
        entity._attach(meta, payload as ComponentInstance);
        return;
      case CommandKind.AddTarget:
        entity._addTarget(meta, payload as Entity);
        return;
      case CommandKind.RemoveTarget:
        entity._removeTarget(meta, payload as Entity);
        return;
    }
  }

  /** @internal Apply mutations in arrival order, then route dirty relationship updates. */
  protected _processCommandQueue(): void {
    if (this._draining) {
      return;
    }
    if (this._commandLength === 0 && this._relationshipUpdateLength === 0) {
      return;
    }
    this._draining = true;
    try {
      let nextUpdate = 0;
      while (
        this._commandHead < this._commandLength ||
        nextUpdate < this._relationshipUpdateLength
      ) {
        // Even an explicit modified(R) preceding an edge must observe the final
        // edge set. Drain mutations (including hook-enqueued commands) first.
        while (this._commandHead < this._commandLength) {
          this._executeCommand(this._commandHead++);
        }
        const entity =
          nextUpdate < this._relationshipUpdateLength
            ? (this._relationshipUpdates[nextUpdate] as Entity)
            : undefined;
        if (entity) {
          const meta = this._relationshipUpdates[nextUpdate + 1] as ComponentMeta;
          this._routingSource = this._relationshipUpdates[nextUpdate + 2] as Entity | undefined;
          if (entity._prepareRelationshipUpdate(meta) && this._commandHead < this._commandLength) {
            continue;
          }
          nextUpdate += 3;
          // Removal/destroy clears the bit. A remove/re-add can leave multiple
          // queued commands, but only the first still-dirty command routes.
          entity._modifiedRelationship(meta);
        }
      }
      for (let j = 0; j < this._commandLength; j++) {
        this._commandEntities[j] = undefined;
        this._commandMetas[j] = undefined;
        this._commandPayloads[j] = undefined;
        this._commandSources[j] = undefined;
      }
      this._commandLength = 0;
      for (let j = 0; j < this._relationshipUpdateLength; j++) {
        this._relationshipUpdates[j] = undefined;
      }
      this._relationshipUpdateLength = 0;
    } finally {
      this._commandHead = 0;
      this._routingSource = undefined;
      this._draining = false;
    }
  }

  /** @internal Whether a slot changes an edge of `meta` on `entity`, or removes `meta`. */
  private _isEdgeCommandFor(index: number, entity: Entity, meta: ComponentMeta): boolean {
    const kind = this._commandKinds[index];
    return (
      (kind === CommandKind.AddTarget ||
        kind === CommandKind.RemoveTarget ||
        kind === CommandKind.Remove) &&
      this._commandEntities[index] === entity &&
      this._commandMetas[index] === meta
    );
  }
}
