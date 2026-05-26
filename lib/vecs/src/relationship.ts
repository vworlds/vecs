import type { Entity } from "./entity/index.js";

/** Base class for relationship components that point at another entity. */
export abstract class Relationship {
  public target!: Entity;
}
