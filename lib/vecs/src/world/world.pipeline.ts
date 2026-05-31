import { IPhase, Phase } from "../phase.js";
import { System } from "../system.js";
import { ALWAYS_TICK_SOURCE, type ITickSource } from "../timer.js";
import type { WorldOptions } from "./world.base.js";
import { Modules } from "./world.modules.js";

export class Pipeline extends Modules {
  /** @internal `true` once {@link start} has prepared the phase pipeline. */
  protected _started = false;
  /** @internal Phase name -> phase. Insertion-ordered, matches pipeline execution order. */
  public _pipeline = new Map<string, Phase>();
  /** @internal World-owned tick sources evaluated once per frame. */
  protected _tickSources: Set<ITickSource> = new Set();
  /** @internal Monotonic frame id used to memoize tick-source evaluation. */
  public _frameCounter = 0;

  public constructor(options: WorldOptions = {}) {
    super(options);
    this._tickSources.add(ALWAYS_TICK_SOURCE);
  }

  /** Add a named phase to the update pipeline. */
  public addPhase(name: string): IPhase {
    const phase = new Phase(name, this);
    this._pipeline.set(name, phase);
    return phase;
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
    this._tickSources.forEach((t) => t._evalTick(delta, this._frameCounter));
  }

  /** Close the current frame. */
  public endFrame(): void {
    if (!this._frameInProgress) {
      throw new Error("beginFrame() not called before endFrame()");
    }
    this._frameInProgress = false;
  }

  /** Run every phase in the pipeline in registration order. */
  public progress(now: number, delta: number): void {
    this.beginFrame(delta);
    try {
      this._pipeline.forEach((phase) => {
        this.runPhase(phase, now, delta);
      });
    } finally {
      this.endFrame();
    }
  }

  /** Execute every system in `phase` within the current frame. */
  public runPhase(phase: IPhase, now: number, delta: number): void {
    if (!this._frameInProgress) {
      throw new Error("runPhase() called outside a frame — call beginFrame() first");
    }
    this.flush();
    (phase as Phase).systems.forEach((s) => {
      s._run(now, delta);
    });
  }

  /** Freeze component registration and prepare the world for running. */
  public start(): void {
    this._buildPendingQueries();
    this._componentRegistrationDisabled = true;
    this._started = true;
    this._reindexSystems();
  }

  /** Create and return a new {@link System}, ready for fluent configuration. */
  public system(name: string): System {
    if (this._started) {
      throw new Error("systems cannot be added after world start");
    }
    return new System(name, this);
  }

  /** @internal Register a tick source with this world. */
  public _registerTickSource(t: ITickSource): void {
    this._tickSources.add(t);
  }

  /** @internal Distribute every registered system into its phase's `systems` list. */
  protected _reindexSystems(): void {
    let _defaultPhase = this._pipeline.get("update");
    if (!_defaultPhase) {
      _defaultPhase = new Phase("update", this);
      this._pipeline.set(_defaultPhase.name, _defaultPhase);
    }

    const defaultPhase = _defaultPhase;

    this._pipeline.forEach((phase) => {
      phase.systems.length = 0;
    });

    this._queries.forEach((q) => {
      if (!(q instanceof System)) {
        return;
      }
      let phase = q._phase as Phase | undefined;
      if (typeof phase === "string") {
        phase = this._pipeline.get(phase);
      }
      phase = phase || defaultPhase;
      phase.systems.push(q);
    });
  }
}
