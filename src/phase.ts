import { type System } from "./system.js";
import { type World } from "./world.js";

/**
 * A named, ordered bucket of {@link System | systems} within the world's
 * update pipeline.
 *
 * Created internally by {@link World.addPhase}. The systems in a phase run in
 * the order they were registered. Between each system run the world flushes
 * pending archetype changes, so `onEnter` / `onExit` callbacks are always
 * delivered before the next system executes.
 *
 * @internal The concrete class is not part of the public API. Use
 * {@link IPhase} to refer to phases in user code.
 */
export class Phase {
  /** Systems that belong to this phase, in execution order. */
  public systems: System[] = [];

  constructor(
    /** Name used to look up the phase in the pipeline. */
    public readonly name: string,
    public world: World
  ) {}
}

/**
 * Public interface for a pipeline phase returned by {@link World.addPhase}.
 *
 * Pass an `IPhase` to {@link System.phase} to assign a system to that phase,
 * or to {@link World.runPhase} to execute it:
 *
 * ```ts
 * const preUpdate = world.addPhase("preupdate");
 * const send      = world.addPhase("send");
 *
 * world.system("NetworkUpdate").phase(preUpdate).onRun(tick);
 *
 * // each frame:
 * world.runPhase(preUpdate, now, delta);
 * world.runPhase(send,      now, delta);
 * ```
 */
export interface IPhase {
  /** The name this phase was registered under. */
  get name(): string;
  /** The world that owns this phase. */
  get world(): World;
}
