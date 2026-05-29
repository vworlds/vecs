import { type ComponentType } from "../component.js";
import { containsDownTerm } from "../dsl.js";
import { SOURCE_TRACKED_QUERY_ERROR, EMPTY_ENTITIES } from "./query.00.base.js";
import { Reactive } from "./query.01.reactive.js";

export class Lifecycle<R extends ComponentType[] = []> extends Reactive<R> {
  protected _backfill(): void {
    if (!this._tracking || !this.rootTerm) {
      return;
    }
    this.world.defer(() => {
      for (const e of this.rootTerm ?? EMPTY_ENTITIES) {
        (this as any)._enter(e);
      }
    });
  }

  public build(): this {
    if (this.built) {
      return this;
    }
    if (this.world.deferred) {
      this.world._addUnbuiltQuery(this as any);
      return this;
    }
    return (this as any)._build();
  }

  public _build(): this {
    if (this.built) {
      return this;
    }
    if (!this._isBuildable()) {
      this.destroy();
      return this;
    }
    this.world._removeUnbuiltQuery(this as any);
    if (this._dsl !== undefined) {
      if (this._tracking && containsDownTerm(this._dsl)) {
        this.destroy();
        throw new Error(SOURCE_TRACKED_QUERY_ERROR);
      }
      this.rootTerm = this.world.getTerm(this._dsl);
      this._unsubscribeTerm = this.rootTerm.subscribe(this);
    }
    this.world._addQuery(this as any);
    this._built = true;
    this._backfill();
    return this;
  }

  public destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.world._removeQuery(this as any);
    this._entities?.clear();
    this._entities = undefined;
    this._tracking = false;
    if (!this.entity._destroyed && this.entity.get(this._queryComponentClass) !== undefined) {
      this.entity.destroy();
    }
  }
}
