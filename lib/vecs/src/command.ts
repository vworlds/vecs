import type { ComponentInstance, ComponentMeta } from "./component.js";
import type { Entity } from "./entity/index.js";

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
  Attach,
  AddTarget,
  RemoveTarget,
}

/**
 * One queued mutation produced by an {@link Entity} method (`add`, `attach`,
 * `set`, `remove`, `destroy`) or by `Entity.modified`, and routed by
 * {@link World} during command-queue processing.
 *
 * In deferred mode the command is appended to `World`'s queue and applied at a
 * well-defined boundary (after each system run, on `flush()`, etc.). Outside
 * deferred mode the corresponding underscore-prefixed `Entity` method is
 * invoked inline.
 *
 * @internal
 */
export type Command = CommandBody & {
  /**
   * Entity credited with producing this mutation — the running system's entity
   * when the command was enqueued, or `undefined` for mutations made outside a
   * system. Stamped by {@link World._enqueue} and consulted during routing to
   * silence feedback loops (see {@link Query.ignoreSource}).
   */
  source?: Entity;
};

/** @internal The discriminated payload of a {@link Command}, without provenance. */
type CommandBody =
  | {
      kind: CommandKind.CreateEntity;
      entity: Entity;
      /** Optional callback run once the entity is registered (used by `getOrCreateEntity`). */
      onCreate?: (entity: Entity) => void;
    }
  | {
      kind: CommandKind.Set;
      entity: Entity;
      meta: ComponentMeta;
      /** Properties to assign. `undefined` for `entity.add(C)` (ensure-exists, no data). */
      props: Partial<ComponentInstance> | undefined;
    }
  | {
      kind: CommandKind.Attach;
      entity: Entity;
      meta: ComponentMeta;
      /** Existing component instance to store directly on the entity. */
      component: ComponentInstance;
    }
  | { kind: CommandKind.Modified; entity: Entity; meta: ComponentMeta }
  | { kind: CommandKind.Remove; entity: Entity; meta: ComponentMeta }
  | { kind: CommandKind.AddTarget; entity: Entity; meta: ComponentMeta; target: Entity }
  | { kind: CommandKind.RemoveTarget; entity: Entity; meta: ComponentMeta; target: Entity }
  | { kind: CommandKind.Destroy; entity: Entity };

/**
 * A queued command that changes a relationship's edges: one edge added, one
 * edge removed, or the whole relationship removed.
 *
 * @internal
 */
export type EdgeCommand = Extract<
  Command,
  { kind: CommandKind.AddTarget | CommandKind.RemoveTarget | CommandKind.Remove }
>;

/**
 * Edge commands queued for one source entity, across its relationships, in
 * queue order: `commands[head]` to `commands[size - 1]` have not applied yet.
 * Applied slots are cleared, and the buffer rewinds once every entry has
 * applied, so one record serves every drain without reallocating.
 *
 * @internal
 */
export interface PendingEdges {
  commands: (EdgeCommand | undefined)[];
  head: number;
  size: number;
}
