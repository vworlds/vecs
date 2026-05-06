import type { Component } from "./component.js";
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
}

/**
 * One queued mutation produced by an {@link Entity} method (`add`, `set`,
 * `remove`, `destroy`, `setParent`) or by `Component.modified`, and routed by
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
      type: number;
      /** Properties to assign. `undefined` for `entity.add(C)` (ensure-exists, no data). */
      props: Partial<Component> | undefined;
    }
  | { kind: CommandKind.Modified; entity: Entity; type: number }
  | { kind: CommandKind.Remove; entity: Entity; type: number }
  | { kind: CommandKind.Destroy; entity: Entity }
  | { kind: CommandKind.SetParent; entity: Entity; parent: Entity | undefined };
