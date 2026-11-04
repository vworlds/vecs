import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, TermEventKind, type TermConsumer } from "./term.js";

/**
 * World-pinned leaf term that matches every entity carrying a specific
 * component type.
 *
 * `ComponentTerm` is the component-presence index. It maintains the live set
 * of entities that have the component identified by `componentEid`. The world
 * routes `add`, `remove`, and `set`/`modified` commands here via the
 * `notifyComponent*` helpers in `build.ts`.
 *
 * - **Membership** events (`componentAdded` / `componentRemoved`) propagate
 *   through staged insertion / entry propagation and `_delete`, fanning out
 *   to all consumers as enter/exit events. Insertion precedes add hooks;
 *   propagation follows them, so direct leaf queries can see the new member
 *   inside a hook before its enter callback fires. Each entity is entered
 *   and exited exactly once per consumer: removing a still-staged entity
 *   exits it only from consumers that subscribed during the hook (and so
 *   already saw it), and propagation then skips both those consumers and
 *   any entity no longer staged.
 * - **Data-only** changes (`componentChanged`) emit only a refresh hint via
 *   `_emitRefresh`, which wakes predicate terms watching this component
 *   without triggering a membership re-evaluation in terms that do not care
 *   about component values.
 */
export class ComponentTerm extends Term {
  /** Entities stored before their add hooks whose entry is not yet propagated, innermost last. */
  private readonly _staged: Entity[] = [];
  /** Per staged entry, the consumers that subscribed while it was staged; created on demand. */
  private _stagedSeen: (TermConsumer[] | undefined)[] | undefined;

  public constructor(
    world: World,
    key: string,
    public readonly componentEid: EID,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "component", true, onDestroy);
    // Registration creates the leaf before the first attachment. All later
    // membership changes drive it, so no world scan is necessary.
  }

  /** @internal Number of entities stored before their add hooks and not yet propagated. */
  public get _stagedCount(): number {
    return this._staged.length;
  }

  /** @internal Whether removal must preserve an injection register for term consumers. */
  public get _observed(): boolean {
    return this._consumers.size > 0;
  }

  /** @internal Record storage membership before add hooks, without notifying consumers. */
  public _stageAdded(entity: Entity): void {
    this._entities.add(entity);
    this._staged.push(entity);
  }

  /**
   * Called by `build.ts` after add hooks to propagate the already-stored
   * membership. A no-op when a hook removed the entity while it was staged.
   */
  public componentAdded(entity: Entity): void {
    const staged = this._staged;
    const top = staged.length - 1;
    if (staged[top] !== entity) {
      return;
    }
    staged.pop();
    const seen = this._takeSeen(top);
    if (seen === undefined) {
      this._propagateAdded(entity);
    } else {
      this._emitTo(TermEventKind.Enter, entity, (consumer) => !seen.includes(consumer));
    }
  }

  /**
   * Called by `build.ts` when the component's value changes on `entity`
   * without a membership change.
   *
   * Emits a refresh hint rather than an enter/exit event so that consumers
   * watching for data updates (predicate terms) are woken while
   * membership-only consumers are not disturbed.
   */
  public componentChanged(entity: Entity): void {
    this._emitRefresh(entity);
  }

  /**
   * @internal Drop `entity`'s staged entry, without events, when its add ends
   * without propagating (an early return or a throwing hook). The entity stays
   * in the term only while it still carries the component.
   */
  public _discardStaged(entity: Entity): void {
    const staged = this._staged;
    if (staged.length === 0) {
      return;
    }
    const index = staged.lastIndexOf(entity);
    if (index < 0) {
      return;
    }
    this._removeStaged(index);
    if (!this._matches(entity)) {
      this._entities.delete(entity);
    }
  }

  /** Called by `build.ts` when the component is removed from `entity`. */
  public componentRemoved(entity: Entity): void {
    if (this._staged.length !== 0 && this._unstage(entity)) {
      return;
    }
    this._delete(entity);
  }

  /** Record a consumer subscribing during add hooks as having seen every staged entity. */
  public override subscribe(consumer: TermConsumer): () => void {
    const unsubscribe = super.subscribe(consumer);
    const staged = this._staged;
    if (staged.length !== 0) {
      const seen = (this._stagedSeen ??= []);
      for (let i = 0; i < staged.length; i++) {
        (seen[i] ??= []).push(consumer);
      }
    }
    return unsubscribe;
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return entity.alive && entity._get(this.componentEid) !== undefined;
  }

  /** Pop the consumers recorded for the staged entry at `index`, the innermost one. */
  private _takeSeen(index: number): TermConsumer[] | undefined {
    const seen = this._stagedSeen;
    if (seen === undefined) {
      return undefined;
    }
    const consumers = seen[index];
    if (index === 0) {
      this._stagedSeen = undefined;
    } else if (seen.length > index) {
      seen.length = index;
    }
    return consumers;
  }

  /** Remove the staged entry at `index` and return the consumers that saw it. */
  private _removeStaged(index: number): TermConsumer[] | undefined {
    const staged = this._staged;
    staged.splice(index, 1);
    const seen = this._stagedSeen;
    let consumers: TermConsumer[] | undefined;
    if (seen !== undefined && index < seen.length) {
      consumers = seen[index];
      seen.splice(index, 1);
    }
    if (staged.length === 0) {
      this._stagedSeen = undefined;
    }
    return consumers;
  }

  /**
   * Remove `entity` if it is still staged, exiting it only from the consumers
   * that saw it during its add hooks. Returns `false` when it is not staged.
   */
  private _unstage(entity: Entity): boolean {
    const index = this._staged.lastIndexOf(entity);
    if (index < 0) {
      return false;
    }
    const consumers = this._removeStaged(index);
    this._entities.delete(entity);
    if (consumers !== undefined) {
      this._emitTo(TermEventKind.Exit, entity, (consumer) => consumers.includes(consumer));
    }
    return true;
  }
}
