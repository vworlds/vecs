import type { Component, ComponentMeta } from "./component.js";
import type { Entity } from "./entity.js";

/**
 * Discriminator for the {@link Command} union.
 *
 * @internal
 */
export const enum CommandKind {
  CreateEntity,
  Set,
  Modified,
  Remove,
  Destroy,
  SetParent,
  Attach,
}

/**
 * One queued mutation produced by an {@link Entity} method (`add`, `attach`,
 * `set`, `remove`, `destroy`, `setParent`) or by `Entity.modified`, and routed by
 * {@link World} during command-queue processing.
 *
 * In deferred mode the command is appended to `World`'s queue and applied at a
 * well-defined boundary (after each system run, on `flush()`, on the next
 * `runPhase`, etc.). Outside deferred mode the corresponding underscore-prefixed
 * `Entity` method is invoked inline.
 *
 * @internal
 */
export type Command =
  | { kind: CommandKind.CreateEntity; entity: Entity }
  | {
      kind: CommandKind.Set;
      entity: Entity;
      meta: ComponentMeta;
      /** Properties to assign. `undefined` for `entity.add(C)` (ensure-exists, no data). */
      props: Partial<Component> | undefined;
    }
  | {
      kind: CommandKind.Attach;
      entity: Entity;
      meta: ComponentMeta;
      /** Existing component instance to store directly on the entity. */
      component: Component;
    }
  | { kind: CommandKind.Modified; entity: Entity; meta: ComponentMeta }
  | { kind: CommandKind.Remove; entity: Entity; meta: ComponentMeta }
  | { kind: CommandKind.Destroy; entity: Entity }
  | { kind: CommandKind.SetParent; entity: Entity; parent: Entity | undefined };
