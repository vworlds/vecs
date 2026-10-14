import { CommandKind } from "../command.js";
import { Component } from "../component.js";
import { Identity, type Entity } from "../entity/index.js";
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
  /** `true` once {@link dispose} has started: repeated top-level calls are idempotent. */
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
   * unspecified. If any entities remain when teardown cannot progress (for example, component-key
   * cycles), an `Error` names every survivor and its carriers. Cycle breaking is not attempted.
   * {@link clearAllEntities} retains its own throwing behavior.
   *
   * ## Call site
   *
   * Call synchronously at top level: not inside {@link progress}, {@link defer}, a command drain
   * or an entity's destroy. A refused call throws before teardown starts, leaving the world
   * usable; call again after the enclosing operation finishes. Ordinary synchronous top-level
   * `add`, `set` and `remove` hooks may call it. Cleanup and commands created by teardown hooks
   * settle before this call returns.
   *
   * ## After disposal
   *
   * A disposed world must not be used again. Nothing enforces it — no other method checks, so
   * mutations have no disposal guard — but the world has no state left to run on. Calling
   * `dispose()` again at top level does nothing. The call-site rule still applies during teardown.
   * Do not create entities indefinitely from teardown hooks: the final pass repeats while it can
   * destroy more entities. Release resources in `remove` hooks, not system `exit` callbacks,
   * which will not run after teardown. A hook that throws propagates out of
   * the call and leaves the world partial, as it does from any destroy: treat it as a programming
   * error.
   *
   * @throws An `Error` for a forbidden call site before any disposal mutation; an `Error`
   * listing remaining entities and their carriers when ordering stalls, or
   * an error propagated by a teardown hook. The latter two errors leave the world partial.
   */
  public dispose(this: World): void {
    this._assertDisposalAllowed();
    if (this._disposeStarted) {
      return;
    }
    this._disposeStarted = true;
    const identityEid = this.getEntity(Identity)?.eid;
    // Identity itself may be destroyed before an unresolved key is reported.
    const labels = new Map<Entity, string>();
    for (const entity of this._entities.values()) {
      const name =
        identityEid === undefined
          ? undefined
          : (entity._get(identityEid) as Identity | undefined)?.name;
      labels.set(entity, `${entity.eid} (${name || entity.meta.Class.name})`);
    }
    // Settle application hooks and any entities they create before removing infrastructure.
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
        // Hooks may change carriers after the order was computed. Never strip a live carrier.
        if (!entity.destroyed && !isCarried(entity)) {
          entity._destroy();
          destroyed++;
          this.flush();
        }
      }
      this.flush();
      if (destroyed === 0) {
        const survivors = this._entities.values().sort((a, b) => a.eid - b.eid);
        if (survivors.length > 0) {
          const label = (entity: Entity): string => {
            const name =
              identityEid === undefined
                ? undefined
                : (entity._get(identityEid) as Identity | undefined)?.name;
            return labels.get(entity) ?? `${entity.eid} (${name || entity.meta.Class.name})`;
          };
          throw new Error(
            `Cannot dispose world; entities remain: ${survivors
              .map(
                (entity) =>
                  `${label(entity)} carried by [${[...(entity.meta._carriers ?? [])].map(label).join(", ")}]`
              )
              .join("; ")}`
          );
        }
        break;
      }
    }
  }

  /**
   * Validate the disposal call site before teardown changes any state.
   * Subclasses overriding {@link dispose} must call this before starting their own cleanup.
   * @throws An `Error` inside a frame, deferred scope, command drain or entity destroy.
   */
  protected _assertDisposalAllowed(): void {
    if (this.deferred || this._frameInProgress || this._deletionScope) {
      throw new Error(
        "dispose() must be called outside progress(), defer, a command drain or an entity's destroy"
      );
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

    return carriersFirst(
      this._entities.values().filter((entity) => !entity.destroyed && !isInfrastructure(entity))
    );
  }
}
