import { type ComponentInstance, type ComponentMeta, type ComponentType } from "../component.js";
import { Entity } from "../entity/index.js";
import { TermConsumer, TermEventKind } from "../terms/term.js";
import { Base } from "./query.00.base.js";

export class Reactive<R extends ComponentType[] = []> extends Base<R> implements TermConsumer {
  /** @internal */
  public _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this as any);
    this._enterCallback?.(e);
    e.components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      if (this._watchlistBitmask.hasBit(meta.bitPtr)) {
        (this as any)._notifyModified(e, meta, c);
      }
    });
  }

  /** @internal */
  public _exit(e: Entity): void {
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this as any);
  }

  /** @internal */
  public _notifyModified(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    if (!this._watchlistBitmask.hasBit(meta.bitPtr)) {
      return;
    }
    if (this._isSourceSilenced()) {
      return;
    }
    const callback = this._componentUpdateCallbacks.get(meta.eid);
    if (callback) {
      callback(e, c);
    }
  }

  /** @internal */
  protected _isSourceSilenced(): boolean {
    const source = this.entity.world._routingSource;
    return source !== undefined && this._silenceQuery?.has(source) === true;
  }

  public onTermEvent(kind: TermEventKind, entity: Entity): void {
    if (kind === TermEventKind.Enter) {
      this._enter(entity);
    } else {
      this._exit(entity);
    }
  }

  /** @internal */
  public _watchesUpdates(): boolean {
    return this._componentUpdateCallbacks.size > 0;
  }

  /** @internal */
  public _unsubscribeRootTerm(): void {
    this._unsubscribeTerm?.();
    this._unsubscribeTerm = undefined;
    this.rootTerm = undefined;
  }
}
