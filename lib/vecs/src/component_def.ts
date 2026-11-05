/**
 * Local schema marker automatically attached to every registered component and
 * module entity, including this tag's own component entity.
 *
 * Use `world.query("Definitions").with(ComponentDef).build()` to enumerate
 * definitions without scanning game entities. Treat the marker as world-managed
 * metadata: do not add or remove it yourself. It is excluded from subtree
 * snapshots and cannot be networked.
 */
export class ComponentDef {}

/**
 * Local schema marker that {@link World.module} attaches to every installed
 * module's definition entity, core modules included.
 *
 * Use `entity.has(ModuleDef)` to tell a module's definition from a plain
 * component definition (both carry `ComponentDef`), or
 * `world.query("Modules").with(ModuleDef).build()` to enumerate installed
 * modules. A class registered with `world.component(M)` but never installed
 * does not carry it. Treat it as world-managed metadata: do not add or remove
 * it yourself. Like `ComponentDef`, it is excluded from subtree snapshots and
 * cannot be networked.
 */
export class ModuleDef {}

/**
 * Declarative marker for component definitions that provide policy for other
 * component types. Mark a custom trait with `world.component(Audited).add(Trait)`.
 *
 * Query `ComponentDef` and `Trait` together to enumerate trait definitions
 * incrementally. This marker installs no hooks and does not restrict which
 * components may be stored on definitions. It does not mark itself.
 *
 * Like `ComponentDef`, it is local schema metadata: excluded from subtree
 * snapshots and rejected in `networkComponents`. Each world marks its own traits.
 */
export class Trait {}
