import { CommandKind } from "../command.js";
import { Component } from "../component.js";
import { type Entity } from "../entity/index.js";
import { Phase } from "../modules/pipeline.js";
import { Query } from "../query/index.js";
import { Module } from "../module.js";
import { carriersFirst, isCarried } from "./destroy-order.js";
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
   * End the world's life: destroy application entities, then all world infrastructure, so the
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
   * ## Order
   *
   * Queued application cleanup finishes before infrastructure teardown starts. Systems and
   * queries precede the components they read; modules prefer reverse registration order.
   * Every component key follows its other carriers; its own singleton is removed with it. Carrier
   * dependencies take precedence over module order. Among other unrelated entities order is
   * unspecified. Keys in cycles or still carried outside the teardown are skipped, not thrown
   * from; {@link clearAllEntities} still throws when it cannot order all entities.
   *
   * ## Pending commands
   *
   * Commands queued by an enclosing deferred scope are neither flushed early nor discarded: they
   * run first, in order, and the destruction follows them in the same queue, so a hook still fires
   * once per component instance however it was removed. An entity whose creation is still queued
   * is created, then destroyed. At top level nothing is queued and `dispose()` returns with the
   * entities gone. Inside {@link progress}, application destruction drains after the running
   * system, but infrastructure and singleton resources stay alive for the remaining systems,
   * until {@link endFrame}, including when a later system throws. Inside {@link defer} outside
   * a frame, infrastructure teardown runs after the enclosing queue drains, including commands
   * appended by application hooks. Its own hooks and commands are settled before completion.
   *
   * A synchronous hook outside both a frame and deferred mode is a limit: an entity already
   * mid-destroy can still carry its remaining component keys. Those keys (and their dependencies)
   * survive, so the ordinary teardown can safely finish their hooks once. The key whose hook is
   * running has already detached this carrier and can be destroyed unless another carrier still
   * needs it. An ordinary remove hook has also detached its key; the queued application pass can
   * destroy the rest of its entity before infrastructure teardown. Prefer disposing outside a
   * hook, or enclose the triggering mutation in {@link defer}, for complete teardown.
   *
   * ## After disposal
   *
   * A disposed world must not be used again. Nothing enforces it — no other method checks, so
   * mutations have no disposal guard — but the world has no state left to run on. Calling
   * `dispose()` again, from a hook included, does nothing. Do not create entities indefinitely
   * from teardown hooks: the final pass repeats while it can destroy more entities. A system's
   * `exit` callback may run later in the disposal tick, but never after teardown; release resources
   * in `remove` hooks. A hook that throws propagates out of
   * the call and leaves the world partial, as it does from any destroy: treat it as a programming
   * error.
   */
  public dispose(this: World): void {
    if (this._disposeStarted) {
      return;
    }
    this._disposeStarted = true;
    this._disposePending = true;
    // The destroys are queued commands, as `Entity.destroy()` makes them in a deferred scope, so a
    // queue that is already filling runs ahead of them. At top level this scope drains them now.
    this.defer(() => {
      for (const entity of this._destroyOrder()) {
        this._enqueue({ kind: CommandKind.Destroy, entity });
      }
      // A deferred dispose with no application entities must still produce a non-empty drain.
      // This marker performs no teardown: hooks can append commands behind it and the live
      // queue loop drains all of them before its single completion check.
      if (this._commandQueue.length === 0) {
        this._enqueue({ kind: CommandKind.DisposalBarrier });
      }
    });
  }

  /** @internal Complete teardown only after application commands, and outside a frame. */
  public _finishDisposal(this: World): void {
    this._disposePending = false;
    // Hooks or later systems may have created application entities since the original snapshot.
    // Drain their ordinary destruction before removing any infrastructure.
    let applications = this._destroyOrder();
    while (applications.length > 0) {
      this.defer(() => {
        for (const entity of applications) {
          this._enqueue({ kind: CommandKind.Destroy, entity });
        }
      });
      applications = this._destroyOrder();
    }
    while (true) {
      const entities = this._entities.values().filter((entity) => !entity.destroyed);
      // The class registry is insertion-ordered; the dense entity map swaps entries on deletion.
      const modules = [...this._classRegistry.values()]
        .filter((entity) => entity instanceof Module && !entity.destroyed)
        .reverse();
      const queryEid = this.getEntity(Query)?.eid;
      const queries = entities.filter((entity) => queryEid !== undefined && entity.has(queryEid));
      const priority = new Set([...queries, ...modules]);
      const ordered = carriersFirst([
        ...queries,
        ...modules,
        ...entities.filter((entity) => !priority.has(entity)),
      ]);
      let destroyed = 0;
      for (const entity of ordered) {
        // Hooks may change carriers after the order was computed. Never strip a live carrier,
        // including a destroyed entity whose synchronous teardown is still on the stack.
        if (!entity.destroyed && !isCarried(entity)) {
          entity._destroy();
          destroyed++;
          this.flush();
        }
      }
      this.flush();
      if (destroyed === 0) {
        break;
      }
    }
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
      entities.filter((entity) => !entity.destroyed && !isInfrastructure(entity))
    );
  }
}
