import type { Component } from "./component.js";
import type { Entity } from "./entity.js";

export const enum CommandKind {
  CreateEntity,
  Set,
  Modified,
  Remove,
  Destroy,
  SetParent,
}

/**
 * Command kinds emitted by {@link Entity} and routed by {@link World}.
 *
 * Commands are produced by `entity.add` / `entity.set` / `entity.remove` /
 * `entity.destroy` (and `Component.modified`). In deferred mode they are
 * pushed onto the world's command queue and processed at well-defined
 * boundaries (after each system run, on `flush()`, on the next `runPhase`,
 * etc.). Outside deferred mode they execute inline.
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
