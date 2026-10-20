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
