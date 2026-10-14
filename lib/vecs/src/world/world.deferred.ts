import { CommandKind, type Command } from "../command.js";
import { Queries } from "./world.queries.js";

export class Deferred extends Queries {
  /** @internal Single ordered command queue used in deferred mode. */
  protected _commandQueue: Command[] = [];
  /** @internal Nested {@link beginDefer} / {@link endDefer} count. */
  protected _deferredDepth = 0;
  /** @internal `true` while {@link _processCommandQueue} is iterating, to avoid re-entrant drains. */
  protected _draining = false;
  /** @internal Infrastructure teardown waiting for a drain or frame boundary. */
  protected _disposePending = false;

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

  /** `true` while the world is in deferred mode. */
  public get deferred(): boolean {
    return this._deferredDepth > 0 || this._draining;
  }

  /** @internal Append a command to the deferred-mode queue. */
  public _enqueue(cmd: Command): void {
    cmd.source = this._currentSource;
    this._commandQueue.push(cmd);
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
      case CommandKind.DisposalBarrier:
        return;
    }
  }

  /** @internal Drain the top-level command queue in arrival order. */
  protected _processCommandQueue(): void {
    if (this._draining) {
      return;
    }
    if (this._commandQueue.length === 0) {
      return;
    }
    this._draining = true;
    try {
      for (let i = 0; i < this._commandQueue.length; i++) {
        this._executeCommand(this._commandQueue[i]);
      }
      this._commandQueue.length = 0;
    } finally {
      this._routingSource = undefined;
      this._draining = false;
    }
    if (this._disposePending && !this._frameInProgress) {
      this._finishDisposal();
    }
  }

  /** @internal Completion boundary supplied by the world's disposal layer. */
  protected _finishDisposal(): void {}
}
