import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, TermEventKind } from "./term.js";

/** A union of component leaves selected by a live source query over key entities. */
export class AnyOfTerm extends Term {
  private readonly _keys: EID[] = [];
  private readonly _keyUnsubscribes = new Map<EID, () => void>();

  public constructor(world: World, key: string, source: Term, onDestroy: (term: Term) => void) {
    super(world, key, "anyOf", false, onDestroy);
    this._setChildren([source]);
    this._addChildCleanup(() => {
      this._keyUnsubscribes.forEach((unsubscribe) => unsubscribe());
      this._keyUnsubscribes.clear();
      this._keys.length = 0;
    });
    for (const entity of source) {
      this._addKey(entity);
    }
  }

  /** @internal Live membership for compiled merged predicates; `has` remains the emitted set. */
  public _matchesLive(entity: Entity): boolean {
    return entity.alive && this._keys.some((key) => entity.componentBitmask.has(key));
  }

  /** @internal Key data refreshes cannot change membership without a source event. */
  protected override _childRefreshesOnlyInFlight(): boolean {
    return true;
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._matchesLive(entity);
  }

  /** @internal Fan source transitions out only to the affected key's holders. */
  protected override _onChildEvent(kind: TermEventKind, entity: Entity): void {
    if (kind === TermEventKind.Enter) {
      this._addKey(entity);
    } else {
      this._removeKey(entity);
    }
  }

  /** @internal Only source membership events matter. */
  protected override _onChildRefresh(): void {}

  private _addKey(entity: Entity): void {
    const key = entity.eid;
    if (this._keyUnsubscribes.has(key)) {
      return;
    }
    const leaf = this.world._getComponentTerm(key);
    this._keys.push(key);
    this._keyUnsubscribes.set(
      key,
      leaf.subscribe({ onTermEvent: (_, e) => this._sync(e), _resyncsOnEvent: true })
    );
    for (const holder of leaf) {
      this._sync(holder);
    }
  }

  private _removeKey(entity: Entity): void {
    const key = entity.eid;
    const unsubscribe = this._keyUnsubscribes.get(key);
    if (!unsubscribe) {
      return;
    }
    unsubscribe();
    this._keyUnsubscribes.delete(key);
    this._keys.splice(this._keys.indexOf(key), 1);
    for (const holder of this.world._getComponentTerm(key)) {
      this._sync(holder);
    }
  }
}
