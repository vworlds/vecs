import type { ComponentType } from "../component.js";
import type { Group } from "./group.js";
import type { Query } from "./query.js";

/** Typed bucket access supplied by {@link Query.groupBy}. */
export interface GroupAccessors<K, R extends ComponentType[]> {
  /** Number of live buckets. Throws when the query is not grouped. */
  readonly groupCount: number;
  /** Look up a live bucket by key; throws when the query is not grouped. */
  group(key: K): Group<K, R> | undefined;
  /** Iterate live buckets; throws when the query is not grouped. */
  groups(): IterableIterator<Group<K, R>>;
  /** Iterate live bucket keys; throws when the query is not grouped. */
  groupKeys(): IterableIterator<K>;
  /** Configure a bucket-creation callback before building; throws when not grouped. */
  onGroupEnter(callback: (group: Group<K, R>) => void): this;
  /** Configure a bucket-removal callback before building; throws when not grouped. */
  onGroupExit(callback: (key: K, group: Group<K, R>) => void): this;
}

/**
 * The type returned by {@link Query.groupBy}: the same Query with typed bucket
 * access. This is a type only, not a runtime class or constructor.
 * The typed accessor intersection comes first so its overloads take precedence
 * over Query's untyped accessor surface.
 *
 * @typeParam K - The computed key type, or Entity for relationship grouping.
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export type GroupedQuery<K = unknown, R extends ComponentType[] = []> = GroupAccessors<K, R> &
  Query<R>;
