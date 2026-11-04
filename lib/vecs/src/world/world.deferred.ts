import { CommandKind, type Command } from "../command.js";
import type { ComponentMeta } from "../component_meta.js";
import type { Entity } from "../entity/entity.js";
import { Queries } from "./world.queries.js";

export class Deferred extends Queries {
  /** @internal Single ordered command queue used in deferred mode. */
  protected _commandQueue: Command[] = [];
  /** @internal Nested {@link beginDefer} / {@link endDefer} count. */
  protected _deferredDepth = 0;
  /** @internal `true` while {@link _processCommandQueue} is iterating, to avoid re-entrant drains. */
  protected _draining = false;
  /**
   * @internal Index of the first command in {@link _commandQueue} not yet taken
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
    const queue = this._commandQueue;
    for (let i = this._commandHead; i < queue.length; i++) {
      const cmd = queue[i]!;
      if (!this._isEdgeCommandFor(cmd, entity, meta)) {
        continue;
      }
      if (cmd.kind === CommandKind.Remove) {
        targets.length = 0;
      } else if (cmd.kind === CommandKind.RemoveTarget) {
        const index = targets.indexOf(cmd.target);
        if (index !== -1) {
          targets.splice(index, 1);
        }
      } else if (!cmd.target.destroyed && !targets.includes(cmd.target)) {
        if (meta.relationshipExclusive) {
          targets.length = 0;
        }
        targets.push(cmd.target);
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
    const queue = this._commandQueue;
    for (let i = queue.length - 1; i >= this._commandHead; i--) {
      const cmd = queue[i]!;
      if (!this._isEdgeCommandFor(cmd, entity, meta)) {
        continue;
      }
      if (cmd.kind === CommandKind.Remove) {
        return false;
      }
      if (cmd.target === target) {
        return cmd.kind === CommandKind.AddTarget;
      }
      if (
        cmd.kind === CommandKind.AddTarget &&
        meta.relationshipExclusive &&
        !cmd.target.destroyed
      ) {
        return false;
      }
    }
    return committed;
  }

  /** @internal Append a command to the deferred-mode queue. */
  public _enqueue(cmd: Command): void {
    cmd.source = this._currentSource;
    this._commandQueue.push(cmd);
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
  protected _executeCommand(cmd: Command): void {
    this._routingSource = cmd.source;
    switch (cmd.kind) {
      case CommandKind.CreateEntity:
        this._entities.set(cmd.entity.eid, cmd.entity);
        this._deferredEntities.delete(cmd.entity.eid);
        this._notifyEntityCreated(cmd.entity);
        cmd.onCreate?.(cmd.entity);
        return;
      case CommandKind.Set:
        cmd.entity._set(cmd.meta, cmd.props);
        return;
      case CommandKind.Modified:
        cmd.entity._modified(cmd.meta);
        return;
      case CommandKind.Remove:
        cmd.entity._remove(cmd.meta);
        return;
      case CommandKind.Destroy:
        cmd.entity._destroy();
        return;
      case CommandKind.Attach:
        cmd.entity._attach(cmd.meta, cmd.component);
        return;
      case CommandKind.AddTarget:
        cmd.entity._addTarget(cmd.meta, cmd.target);
        return;
      case CommandKind.RemoveTarget:
        cmd.entity._removeTarget(cmd.meta, cmd.target);
        return;
    }
  }

  /** @internal Apply mutations in arrival order, then route dirty relationship updates. */
  protected _processCommandQueue(): void {
    if (this._draining) {
      return;
    }
    if (this._commandQueue.length === 0 && this._relationshipUpdateLength === 0) {
      return;
    }
    this._draining = true;
    try {
      let nextUpdate = 0;
      while (
        this._commandHead < this._commandQueue.length ||
        nextUpdate < this._relationshipUpdateLength
      ) {
        // Even an explicit modified(R) preceding an edge must observe the final
        // edge set. Drain mutations (including hook-enqueued commands) first.
        while (this._commandHead < this._commandQueue.length) {
          this._executeCommand(this._commandQueue[this._commandHead++]!);
        }
        const entity =
          nextUpdate < this._relationshipUpdateLength
            ? (this._relationshipUpdates[nextUpdate] as Entity)
            : undefined;
        if (entity) {
          const meta = this._relationshipUpdates[nextUpdate + 1] as ComponentMeta;
          this._routingSource = this._relationshipUpdates[nextUpdate + 2] as Entity | undefined;
          if (
            entity._prepareRelationshipUpdate(meta) &&
            this._commandHead < this._commandQueue.length
          ) {
            continue;
          }
          nextUpdate += 3;
          // Removal/destroy clears the bit. A remove/re-add can leave multiple
          // queued commands, but only the first still-dirty command routes.
          entity._modifiedRelationship(meta);
        }
      }
      this._commandQueue.length = 0;
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

  /** @internal Whether `cmd` adds or removes an edge of `meta` on `entity`, or removes `meta` from it. */
  private _isEdgeCommandFor(
    cmd: Command,
    entity: Entity,
    meta: ComponentMeta
  ): cmd is Extract<
    Command,
    { kind: CommandKind.AddTarget | CommandKind.RemoveTarget | CommandKind.Remove }
  > {
    return (
      (cmd.kind === CommandKind.AddTarget ||
        cmd.kind === CommandKind.RemoveTarget ||
        cmd.kind === CommandKind.Remove) &&
      cmd.entity === entity &&
      cmd.meta === meta
    );
  }
}
