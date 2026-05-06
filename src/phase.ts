import { type System } from "./system.js";
import { type World } from "./world.js";

/**
 * Public interface for a pipeline phase, returned by {@link World.addPhase}.
 *
 * Pass an `IPhase` to {@link System.phase} to assign a system to the phase, or
 * to {@link World.runPhase} to execute the phase:
 *
 * ```ts
 * const preUpdate = world.addPhase("preupdate");
 * const send      = world.addPhase("send");
 *
 * world.system("NetworkUpdate").phase(preUpdate).run(tick);
 *
 * // each frame:
 * world.runPhase(preUpdate, now, delta);
 * world.runPhase(send,      now, delta);
 * ```
 */
export interface IPhase {
  /** Name this phase was registered under. */
  get name(): string;
  /** World that owns this phase. */
  get world(): World;
}

/**
 * Concrete implementation of {@link IPhase}: a named, ordered bucket of
 * {@link System | systems} within a world's update pipeline.
 *
 * Created by {@link World.addPhase}. Systems run in the order they were added
 * to the phase. Between systems the world drains pending commands so each
 * system observes a consistent view of the world.
 *
 * @internal The class itself is not part of the public API; user code should
 * refer to phases via {@link IPhase}.
 */
export class Phase implements IPhase {
  /** Systems registered in this phase, in execution order. */
  public systems: System[] = [];

  constructor(
    /** Name used to look up the phase in the pipeline. */
    public readonly name: string,
    /** World that owns this phase. */
    public world: World
  ) {}
}
