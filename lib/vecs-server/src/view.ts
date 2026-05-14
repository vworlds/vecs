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
    }
  }

  public get tracker(): IEntityTracker {
    if (this._tracker === undefined) {
      throw new Error("View tracker is undefined");
    }
    return this._tracker;
  }

  /** @internal */
  public _tracker: IEntityTracker | undefined = undefined;

  /** @internal */
  public _tracker_key: number | undefined = undefined;

  /** @internal */
  public _old_tracker: IEntityTracker | undefined = undefined;
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

  public getTracker(dsl: QueryDSL): IEntityTracker {
    const key = getDSLKey(dsl, this._world);
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
