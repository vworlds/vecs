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
