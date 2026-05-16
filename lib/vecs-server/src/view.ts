import { type Entity, getDSLKey, Query, type QueryDSL, type World } from "@vworlds/vecs";

export interface IEntityTracker {
  forEach(callbackfn: (value: Entity) => void): void;
  has(value: Entity): boolean;
  readonly count: number;
  addRef(): void;
  release(): number;
}

export class View {
  private _dsl: QueryDSL | undefined = undefined;

  public get dsl(): QueryDSL | undefined {
    return this._dsl;
  }

  public set dsl(value: QueryDSL | undefined) {
    if (this._dsl === value) {
      return;
    }
    this._dsl = value;
    if (this._tracker !== undefined && this._old_tracker === undefined) {
      this._old_tracker = this._tracker;
      this._old_tracker_key = this._tracker_key;
    }
  }

  public get tracker(): IEntityTracker {
    if (this._tracker === undefined) {
      throw new Error("View tracker is undefined");
    }
    return this._tracker;
  }

  /** @internal */
  public _refreshTracker(cache: TrackerCache): void {
    if (this.dsl === undefined) {
      if (this._tracker !== undefined && this._tracker !== this._old_tracker) {
        cache.returnTracker(this._tracker);
      }
      this._tracker = undefined;
      this._tracker_key = undefined;
      return;
    }

    const key = cache.getKey(this.dsl);
    if (this._tracker_key === key) {
      return;
    }

    if (this._old_tracker !== undefined && this._old_tracker_key === key) {
      if (this._tracker !== undefined && this._tracker !== this._old_tracker) {
        cache.returnTracker(this._tracker);
      }
      this._tracker = this._old_tracker;
      this._tracker_key = this._old_tracker_key;
      return;
    }

    if (this._tracker !== undefined && this._tracker !== this._old_tracker) {
      cache.returnTracker(this._tracker);
    }
    this._tracker = cache.getTracker(this.dsl);
    this._tracker_key = key;
  }

  /** @internal */
  public _releaseTrackers(cache: TrackerCache): void {
    if (this._tracker !== undefined && this._tracker !== this._old_tracker) {
      cache.returnTracker(this._tracker);
    }
    this._tracker = undefined;
    this._tracker_key = undefined;
    if (this._old_tracker !== undefined) {
      cache.returnTracker(this._old_tracker);
      this._old_tracker = undefined;
      this._old_tracker_key = undefined;
    }
  }

  /** @internal */
  public _tracker: IEntityTracker | undefined = undefined;

  /** @internal */
  public _tracker_key: number | undefined = undefined;

  /** @internal */
  public _old_tracker: IEntityTracker | undefined = undefined;

  /** @internal */
  public _old_tracker_key: number | undefined = undefined;
}

export class EntityTracker extends Query implements IEntityTracker {
  public refCount = 0;

  public constructor(
    world: World,
    public readonly dsl: QueryDSL
  ) {
    super(`View:${getDSLKey(dsl, world)}`, world);
    this.query(dsl);
  }

  public addRef(): void {
    this.refCount++;
  }

  public release(): number {
    this.refCount--;
    if (this.refCount <= 0) {
      this.destroy();
      return 0;
    }
    return this.refCount;
  }
}

export class TrackerCache {
  private readonly _trackers = new Map<number, EntityTracker>();
  private readonly _trackerKeys = new Map<IEntityTracker, number>();

  public constructor(private readonly _world: World) {}

  public getKey(dsl: QueryDSL): number {
    return getDSLKey(dsl, this._world);
  }

  public getTracker(dsl: QueryDSL): IEntityTracker {
    const key = this.getKey(dsl);
    let tracker = this._trackers.get(key);
    if (tracker === undefined) {
      tracker = new EntityTracker(this._world, dsl);
      this._trackers.set(key, tracker);
      this._trackerKeys.set(tracker, key);
    }
    tracker.addRef();
    return tracker;
  }

  public returnTracker(tracker: IEntityTracker): void {
    const key = this._trackerKeys.get(tracker);
    const refs = tracker.release();
    if (refs === 0 && key !== undefined) {
      this._trackers.delete(key);
      this._trackerKeys.delete(tracker);
    }
  }
}
