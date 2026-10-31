import { type QuerySpec } from "../dsl.js";
import { type Entity } from "../entity/index.js";
import { Query } from "../query/index.js";
import { System } from "../system.js";
import { AlwaysTickSource, type ITickSource } from "../timer.js";
import type { WorldOptions } from "./world.base.js";
import { Disposal } from "./world.disposal.js";
import { WorldStats } from "./stats.js";

export class Pipeline extends Disposal {
  /** Opt-in per-system timing, including each admitted system's subsequent flush. */
  public readonly stats = new WorldStats(() => this._pipeline);
  /** @internal Flat system execution pipeline, rebuilt from `_pipelineQuery`. */
  public _pipeline: System[] = [];
  /** @internal Query whose ordered result defines the system pipeline. */
  protected _pipelineQuery: Query<[typeof System]> | undefined = undefined;
  /** @internal This world's every-frame clock, the default cadence of its systems. */
  protected readonly _alwaysTickSource = new AlwaysTickSource();
  /** @internal World-owned tick sources evaluated once per frame. */
  protected _tickSources: Set<ITickSource> = new Set();
  /** @internal Monotonic frame id used to memoize tick-source evaluation. */
  public _frameCounter = 0;

  public constructor(options: WorldOptions = {}) {
    super(options);
    this._tickSources.add(this._alwaysTickSource);
  }

  /**
   * This world's every-frame clock. Systems without an explicit cadence use it,
   * so `system.cadence === system.world.alwaysTickSource` identifies the
   * default cadence. Each world owns its own, so nested `progress` calls never
   * share deltas.
   */
  public get alwaysTickSource(): ITickSource {
    return this._alwaysTickSource;
  }

  /**
   * Systems in pipeline execution order, including disabled systems.
   * Between frames, builds pending queries (finishing builder configuration)
   * and refreshes the existing flat pipeline only when its query changed.
   * During a frame, returns that frame's pipeline. Does not drain deferred
   * commands or run systems.
   * The array is read-only at the type level; do not mutate it. Re-read this
   * getter after configuration changes rather than retaining an old array.
   */
  public get pipeline(): readonly System[] {
    if (!this._frameInProgress) {
      this._buildPendingQueries();
      this._refreshPipelineIfChanged();
    }
    return this._pipeline;
  }

  /** Open a new frame and evaluate every registered tick source once. */
  public beginFrame(delta: number): void {
    if (this._frameInProgress) {
      throw new Error("endFrame() not called before beginFrame()");
    }
    this._frameInProgress = true;
    this._frameCounter++;
    this._advanceIdPoolFrame();
    this.flush();
    this._refreshPipelineIfChanged();
    this._tickSources.forEach((t) => t._evalTick(delta, this._frameCounter));
  }

  /** Close the current frame. */
  public endFrame(): void {
    if (!this._frameInProgress) {
      throw new Error("beginFrame() not called before endFrame()");
    }
    this._frameInProgress = false;
  }

  /** Run every system in pipeline order; opt-in stats include each system's flush. */
  public progress(now: number, delta: number): void {
    this.beginFrame(delta);
    try {
      if (this.stats.systemsEnabled) {
        this._progressInstrumented(now, delta);
      } else {
        for (const system of this._pipeline) {
          system._run(now, delta);
          this.flush();
        }
      }
    } finally {
      this.endFrame();
    }
  }

  /** Define the query whose ordered results become this world's system pipeline. */
  public setPipeline<const S extends QuerySpec>(spec: S): Query<[typeof System]> {
    this._pipelineQuery?.destroy();
    const query = this.query("vecs::Pipeline").with(spec).with(System).track();
    this._pipelineQuery = query as Query<[typeof System]>;
    this._pipeline.length = 0;
    return this._pipelineQuery;
  }

  /** Create and return a new {@link System}, ready for fluent configuration. */
  public system(name: string): System {
    return new System(name, this);
  }

  /** @internal Register a tick source with this world. */
  public _registerTickSource(t: ITickSource): void {
    this._tickSources.add(t);
  }

  /** @internal Rebuild the flat pipeline when its query changed. */
  protected _refreshPipelineIfChanged(): void {
    if (!this._pipelineQuery || !this._pipelineQuery.changed) {
      return;
    }
    const systems: System[] = [];
    this._pipelineQuery.forEach([System], (entity: Entity, [system]) => {
      if (system !== undefined && system.entity === entity) {
        systems.push(system);
      }
    });
    this._pipeline = systems;
  }

  private _progressInstrumented(now: number, delta: number): void {
    for (const system of this._pipeline) {
      const slot = this.stats._systemSlot(system);
      const start = performance.now();
      const ran = system._run(now, delta);
      this.flush();
      const elapsed = performance.now() - start;
      if (ran) {
        this.stats._record(slot, elapsed);
      }
    }
  }
}
