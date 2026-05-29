import type { Entity } from "./entity/index.js";

/** Base class for relationship components that point at another entity. */
export abstract class Relationship {
  public target!: Entity;
}

/** Built-in parent-child relationship. */
export class ChildOf extends Relationship {}

/**
 * Built-in relationship marking a feedback **silence domain** for a query
 * or system.
 *
 * When a query carries a `SilenceSource` pointing at a query entity, it
 * ignores `update` notifications whose originating entity (the system
 * that wrote the component) is a member of that query. Configure it through
 * {@link Query.ignoreSource}.
 */
export class SilenceSource extends Relationship {}
