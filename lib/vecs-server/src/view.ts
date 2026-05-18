import { type Entity, getDSLKey, Query, type QueryDSL, type World } from "@vworlds/vecs";
import { Networked } from "./networked.js";

export interface IEntityTracker {
  forEach(callbackfn: (value: Entity) => void): void;
  has(value: Entity): boolean;
  readonly count: number;
  addRef(): void;
  release(): number;
  subscribe(listener: IEntityTrackerListener): void;
  unsubscribe(listener: IEntityTrackerListener): void;
}

export interface IEntityTrackerListener {
  enter(entity: Entity): void;
  exit(entity: Entity): void;
}

export class View implements IEntityTrackerListener {
  private _dsl: QueryDSL = false;

  public get dsl(): QueryDSL {
    return this._dsl;
  }

  public set dsl(value: QueryDSL) {
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

  public canSee(entity: Entity): boolean {
    return this.tracker.has(entity);
  }

  public enter(entity: Entity): void {
    if (this._visible.has(entity)) {
      return;
    }
    this._visible.add(entity);
    this._exitedView.delete(entity);
    this._enteredView.add(entity);
  }

  public exit(entity: Entity): void {
    if (!this._visible.delete(entity)) {
      return;
    }
    if (!this._enteredView.delete(entity)) {
      this._exitedView.add(entity);
    }
  }

  /** @internal */
  public _refreshTracker(cache: TrackerCache): void {
    const key = cache.getKey(this.dsl);
    if (this._tracker_key === key) {
      if (this._old_tracker === this._tracker) {
        this._old_tracker = undefined;
        this._old_tracker_key = undefined;
      }
      return;
    }

    if (this._old_tracker !== undefined && this._old_tracker_key === key) {
      const currentTracker = this._tracker;
      this._setTracker(this._old_tracker);
      this._tracker_key = this._old_tracker_key;
      if (currentTracker !== undefined && currentTracker !== this._old_tracker) {
        cache.returnTracker(currentTracker);
      }
      return;
    }

    const currentTracker = this._tracker;
    this._setTracker(cache.getTracker(this.dsl));
    this._tracker_key = key;
    if (currentTracker !== undefined && currentTracker !== this._old_tracker) {
      cache.returnTracker(currentTracker);
    }
  }

  /** @internal */
  public _reconcileVisibility(): void {
    if (!this._needsVisibilityReconcile) {
      return;
    }
    this._needsVisibilityReconcile = false;

    const exits: Entity[] = [];
    this._visible.forEach((entity) => {
      if (!this.tracker.has(entity)) {
        exits.push(entity);
      }
    });
    exits.forEach((entity) => this.exit(entity));
    this.tracker.forEach((entity) => this.enter(entity));
  }

  /** @internal */
  public _releaseOldTracker(cache: TrackerCache): void {
    if (this._old_tracker !== undefined && this._old_tracker !== this._tracker) {
      cache.returnTracker(this._old_tracker);
    }
    this._old_tracker = undefined;
    this._old_tracker_key = undefined;
  }

  /** @internal */
  public _releaseTrackers(cache: TrackerCache): void {
    const tracker = this._tracker;
    tracker?.unsubscribe(this);
    if (tracker !== undefined && tracker !== this._old_tracker) {
      cache.returnTracker(tracker);
    }
    this._tracker = undefined;
    this._tracker_key = undefined;
    this._releaseOldTracker(cache);
    this._needsVisibilityReconcile = false;
    this._visible.clear();
    this._enteredView.clear();
    this._exitedView.clear();
  }

  private _setTracker(tracker: IEntityTracker | undefined): void {
    if (this._tracker === tracker) {
      return;
    }
    this._tracker?.unsubscribe(this);
    this._tracker = tracker;
    tracker?.subscribe(this);
    this._needsVisibilityReconcile = true;
  }

  /** @internal */
  public readonly _visible = new Set<Entity>();

  /** @internal */
  public readonly _enteredView = new Set<Entity>();

  /** @internal */
  public readonly _exitedView = new Set<Entity>();

  /** @internal */
  public _needsVisibilityReconcile = false;

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
  private readonly _listeners = new Set<IEntityTrackerListener>();

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

  public subscribe(listener: IEntityTrackerListener): void {
    this._listeners.add(listener);
  }

  public unsubscribe(listener: IEntityTrackerListener): void {
    this._listeners.delete(listener);
  }

  /** @internal */
  public override _enter(e: Entity): void {
    super._enter(e);
    this._listeners.forEach((listener) => listener.enter(e));
  }

  /** @internal */
  public override _exit(e: Entity): void {
    super._exit(e);
    this._listeners.forEach((listener) => listener.exit(e));
  }

  public override destroy(): void {
    this._listeners.clear();
    super.destroy();
  }
}

export class TrackerCache {
  private readonly _trackers = new Map<number, EntityTracker>();
  private readonly _trackerKeys = new Map<IEntityTracker, number>();

  public constructor(private readonly _world: World) {}

  public getKey(dsl: QueryDSL): number {
    return getDSLKey(this._trackedDSL(dsl), this._world);
  }

  public getTracker(dsl: QueryDSL): IEntityTracker {
    const key = this.getKey(dsl);
    let tracker = this._trackers.get(key);
    if (tracker === undefined) {
      tracker = new EntityTracker(this._world, this._trackedDSL(dsl));
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

  private _trackedDSL(dsl: QueryDSL): QueryDSL {
    return { AND: [dsl, Networked] };
  }
}
