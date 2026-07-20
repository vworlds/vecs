import { Relationship } from "../component_meta.js";

/**
 * Exclusive relationship from an entity to the template whose components it
 * inherits. Add it with `entity.add(IsA, template)`.
 */
export class IsA extends Relationship {}

/**
 * Per-component inheritance policy relationship.
 *
 * Configure a component with one of {@link Override}, {@link Inherit}, or
 * {@link DontInherit}. Components without an explicit policy use
 * {@link Override}.
 */
export class OnInstantiate extends Relationship {}

/** Marker selecting a one-time shallow copy when an `IsA` edge is added. */
export class Override {}

/**
 * Marker selecting reactive inheritance from an `IsA` template.
 *
 * The inheritor reads the template's component instance until it mutates the
 * component through vecs, at which point vecs creates a local shallow copy.
 */
export class Inherit {}

/** Marker excluding a component from `IsA` inheritance. */
export class DontInherit {}
