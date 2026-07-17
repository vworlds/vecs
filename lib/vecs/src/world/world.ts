import { SilenceSource } from "../modules/relationships.js";
import { IdentityModule } from "../modules/identity.js";
import { ImplementsModule } from "../modules/implements.js";
import { PipelineModule } from "../modules/pipeline.js";
import { RelationshipsModule } from "../modules/relationships.js";
import { SingletonModule } from "../modules/singleton.js";
import { Query } from "../query/index.js";
import { System } from "../system.js";
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
 * 2. **Build the pipeline** — attach systems to phase entities with
 *    `DependsOn`, or call {@link setPipeline} with a custom query spec.
 * 3. **Run loop** — call {@link progress} once per frame.
 *
 * ## Deferred mode
 *
 * The world can be in **deferred mode**, in which case entity mutations
 * (`add` / `attach` / `set` / `remove` / `destroy` / `modified`) are
 * queued instead of applied inline. Systems run inside an automatically
 * deferred scope; user code can wrap arbitrary blocks with
 * {@link beginDefer} / {@link endDefer} or {@link defer}. {@link flush}
 * drains the queue at top level.
 *
 * ## Fatal errors
 *
 * Command application, validation, and user callbacks are fail-fast. An
 * exception propagates from the active direct mutation or synchronization
 * boundary (`flush`, `endDefer`, `defer`, `forEach`, or `progress`) and
 * invalidates this world. vecs provides no rollback, observer isolation, queue
 * recovery, or supported reuse after such an exception; discard the world.
 */
export class World extends Pipeline {
  public constructor(options: WorldOptions = {}) {
    super(options);
    this.component(SilenceSource).onRemove((entity) => entity.get(Query)?._clearSilence());
    this.component(Query).onRemove((_entity, query) => query.destroy());
    this.component(System).onRemove((_entity, system) => system.destroy());
    [
      IdentityModule,
      ImplementsModule,
      SingletonModule,
      RelationshipsModule,
      PipelineModule,
    ].forEach((mod) => this.module(mod));
  }
}
