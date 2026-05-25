import { Pipeline } from "./world.pipeline.js";
import { type WorldOptions } from "./world.base.js";

/**
 * The central ECS container. One world per game session.
 *
 * A `World` owns every entity, every registered component class, every
 * registered query / system, and the update pipeline. The typical lifecycle:
 *
 * 1. **Register components** — call {@link component} for every component
 *    class you plan to use.
 * 2. **Build the pipeline** — {@link addPhase} for every named phase, then
 *    {@link system} / {@link query} for each processor.
 * 3. **Start** — call {@link start} to freeze component registration and
 *    distribute systems into their phases.
 * 4. **Run loop** — call {@link runPhase} per phase or {@link progress} for
 *    every phase, once per frame.
 *
 * ## Deferred mode
 *
 * The world can be in **deferred mode**, in which case entity mutations
 * (`add` / `attach` / `set` / `remove` / `destroy` / `setParent` / `modified`) are
 * queued instead of applied inline. Systems run inside an automatically
 * deferred scope; user code can wrap arbitrary blocks with
 * {@link beginDefer} / {@link endDefer} or {@link defer}. {@link flush}
 * drains the queue at top level.
 */
export class World extends Pipeline {
  public constructor(options: WorldOptions = {}) {
    super(options);
  }
}
