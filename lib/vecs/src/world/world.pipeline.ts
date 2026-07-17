import { type QuerySpec } from "../dsl.js";
import { type Entity } from "../entity/index.js";
import { Query } from "../query/index.js";
import { System } from "../system.js";
import { ALWAYS_TICK_SOURCE, type ITickSource } from "../timer.js";
import type { WorldOptions } from "./world.base.js";
import { Modules } from "./world.modules.js";

export class Pipeline extends Modules {
  /** @internal Flat system execution pipeline, rebuilt from `_pipelineQuery`. */
  public _pipeline: System[] = [];
  /** @internal Query whose ordered result defines the system pipeline. */
  protected _pipelineQuery: Query<[typeof System]> | undefined;
  /** @internal World-owned tick sources evaluated once per frame. */
  protected _tickSources: Set<ITickSource> = new Set();
  /** @internal Monotonic frame id used to memoize tick-source evaluation. */
  public _frameCounter = 0;

  public constructor(options: WorldOptions = {}) {
    super(options);
    this._tickSources.add(ALWAYS_TICK_SOURCE);
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

  /**
   * Run every system in pipeline query order, flushing after each one.
   *
   * A system, callback, validation, or command exception propagates immediately
   * and invalidates the current world. The frame is not repaired or completed.
   */
  public progress(now: number, delta: number): void {
    this.beginFrame(delta);
    for (const system of this._pipeline) {
      system._run(now, delta);
      this.flush();
    }
    this.endFrame();
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
    this._assertQueryCreationAllowed();
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
}
