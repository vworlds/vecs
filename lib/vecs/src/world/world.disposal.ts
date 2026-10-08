import { CommandKind } from "../command.js";
import { Component } from "../component.js";
import { type Entity } from "../entity/index.js";
import { Phase } from "../modules/pipeline.js";
import { Query } from "../query/index.js";
import { Transfers } from "./world.transfers.js";
import type { World } from "./world.js";

/**
 * World teardown. It is a layer of its own rather than a method of `World`, because the layers
 * below pass `this` to parameters typed `World`, which only holds while `World` adds no members
 * to `Pipeline`.
 */
export class Disposal extends Transfers {
  /** `true` once {@link dispose} has started: what makes it idempotent and safe to re-enter. */
  private _disposeStarted = false;

  /**
   * End the world's life: destroy every entity the application and its modules created, so the
   * `remove` hooks of the components they carry release what those components own (render
   * objects, handles, timers). Call it when the world is finished — a scene or route change, a
   * hot reload — and drop the reference afterwards.
   *
   * Each entity goes through the ordinary destroy path, as if it had received
   * {@link Entity.destroy}: every component's `remove` hook fires exactly once, cleanup policies
   * and relationship cascades (`ChildOf`, `OwnedTarget`, `CleanupPolicy.Delete`) run as they
   * always do, and an entity a cascade or a hook has already destroyed is skipped, never
   * destroyed twice.
   *
   * ## What stays
   *
   * The infrastructure the world needs to stay coherent is not destroyed:
   *
   * - component and module entities (every {@link Component}),
   * - the entities behind queries and systems (they carry the {@link Query} component), and
   * - phase entities (they carry the {@link Phase} component).
   *
   * What those entities hold stays too: data stored on a component entity (a singleton set with
   * {@link set}) and any entity they still carry as a component key, which cannot be destroyed
   * while it is in use. Release such data yourself. {@link clearAllEntities} is the full wipe,
   * infrastructure included.
   *
   * ## Order
   *
   * No order is specified among unrelated entities, so do not make a hook depend on one. The one
   * guarantee is that an entity used as a component key is destroyed after every entity that
   * carries it, because destroying it earlier would throw under the default cleanup policy.
   *
   * ## Pending commands
   *
   * Commands queued by an enclosing deferred scope are neither flushed early nor discarded: they
   * run first, in order, and the destruction follows them in the same queue, so a hook still fires
   * once per component instance however it was removed. An entity whose creation is still queued
   * is created, then destroyed. At top level nothing is queued and `dispose()` returns with the
   * application's entities gone. Called from a system, a hook or a {@link defer} block, it queues
   * the destruction like any `destroy()` in that situation, and the destruction completes when
   * the queue next drains: right after the running system, or at the end of the `defer` block.
   *
   * ## After disposal
   *
   * A disposed world must not be used again. Nothing enforces it — no other method checks, so
   * `entity()` and `progress()` stay as cheap as ever — but the world has no application state
   * left to run on. Calling `dispose()` again, from a hook included, does nothing. A hook that
   * creates entities while the world is being disposed leaves them behind. A system's `exit`
   * callback only queues its event, and a disposed world never runs the system again, so release
   * resources in `remove` hooks, which fire during the call. A hook that throws propagates out of
   * the call and leaves the world partial, as it does from any destroy: treat it as a programming
   * error.
   */
  public dispose(this: World): void {
    if (this._disposeStarted) {
      return;
    }
    this._disposeStarted = true;
    // The destroys are queued commands, as `Entity.destroy()` makes them in a deferred scope, so a
    // queue that is already filling runs ahead of them. At top level this scope drains them now.
    this.defer(() => {
      for (const entity of this._destroyOrder()) {
        this._enqueue({ kind: CommandKind.Destroy, entity });
      }
    });
  }

  /**
   * The entities {@link dispose} destroys, in an order that lets every destroy succeed: those the
   * application created, with each one used as a component key after its carriers.
   */
  private _destroyOrder(this: World): Entity[] {
    // `getEntity` rather than `entity`: `clearAllEntities()` unregisters these components.
    const queryEid = this.getEntity(Query)?.eid;
    const phaseEid = this.getEntity(Phase)?.eid;
    const isInfrastructure = (entity: Entity): boolean =>
      entity instanceof Component ||
      (queryEid !== undefined && entity.has(queryEid)) ||
      (phaseEid !== undefined && entity.has(phaseEid));

    const entities = this._entities.values();
    // In a deferred scope an entity created earlier is only queued, not registered yet. Its
    // creation runs ahead of the destroy that is queued after it.
    for (const command of this._commandQueue) {
      if (
        command.kind === CommandKind.CreateEntity &&
        !command.entity.destroyed &&
        this._entities.get(command.entity.eid) !== command.entity
      ) {
        entities.push(command.entity);
      }
    }
    return carriersFirst(
      entities.filter((entity) => !isInfrastructure(entity)),
      isInfrastructure
    );
  }
}

/**
 * Order `entities` so that an entity used as a component key follows every entity that carries it.
 *
 * A key destroyed while still carried throws under the default cleanup policy, so carriers go
 * first. A key that something outside `entities` carries, which is infrastructure in practice, or
 * that is caught in a cycle, cannot be ordered and is left out: destroying it would throw or strip
 * the infrastructure.
 */
function carriersFirst(
  entities: Entity[],
  isInfrastructure: (entity: Entity) => boolean
): Entity[] {
  const ordered: Entity[] = [];
  const keys = new Set<Entity>();
  for (const entity of entities) {
    if (entity.instanceCount() === 0) {
      ordered.push(entity);
    } else {
      keys.add(entity);
    }
  }
  let progressed = keys.size > 0;
  while (progressed) {
    progressed = false;
    for (const key of keys) {
      if (!isCarried(key, keys, isInfrastructure)) {
        ordered.push(key);
        keys.delete(key);
        progressed = true;
      }
    }
  }
  return ordered;
}

/** Whether `key` is still carried by another key that waits to be ordered, or by infrastructure. */
function isCarried(
  key: Entity,
  waiting: ReadonlySet<Entity>,
  isInfrastructure: (entity: Entity) => boolean
): boolean {
  for (const carrier of key.meta._carriers ?? []) {
    if (carrier !== key && (waiting.has(carrier) || isInfrastructure(carrier))) {
      return true;
    }
  }
  return false;
}
