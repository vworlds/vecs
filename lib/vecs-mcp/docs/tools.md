# Tools reference

Discover and address entities, components, relationships and systems by public names.

Every world tool accepts `target?`, the full `<node>/<world>` path. Components use
class names; duplicate class names are exposed as `Name@eid` and the ambiguous
bare name is rejected. Entities use a positive eid or an `Identity` name.

[Browser clients](./clients.md) add `<node>/<world>/<connectionId>` targets with
`kind: "client"` and `client: { id, eid, name? }` metadata to `vecs_targets`.
All world tools accept those paths too.

| Tool              | Parameters                                                                                                   | Result                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vecs_targets`    | None                                                                                                         | Cached aggregate `{ node, targets: [{ path, kind: "world", world: { name, entities, components, systems }, node, via }] }`; see [topology](./topology.md) |
| `vecs_components` | `target?`, `filter?` (case-sensitive name substring)                                                         | Array of `{ name, eid, kind, trait, module?, carriers, traits, schema, description? }`                                                                    |
| `vecs_find`       | `target?`, `where`, `include?` (component names, default none), `limit?` (default 50), `offset?` (default 0) | `{ total, entities: [{ eid, name?, components }] }`; total is before pagination                                                                           |
| `vecs_entity`     | `target?`, `entity`                                                                                          | `{ eid, name?, parent, components, relationships }`; each relationship has `targets` and `children` eids                                                  |
| `vecs_mutate`     | `target?`, `ops`                                                                                             | `{ applied, error?: { index, message } }`; each completed op returns `{ eid }`                                                                            |
| `vecs_systems`    | `target?`, `enable?`, `disable?` (system names)                                                              | Pipeline-order array of `{ name, phase, enabled, callbacks, watched, timing }`                                                                            |
| `vecs_stats`      | `target?`                                                                                                    | `{ systems, operations }`; system identities are names, not live instances                                                                                |
| `vecs_watch`      | `target?`, `where`, `include?`, `maxEvents?` (1000)                                                          | `{ watch, members }`; no backfill events                                                                                                                  |
| `vecs_events`     | `target?`, `watch`, `since?` (0), `limit?` (100)                                                             | `{ events, latest, dropped }`                                                                                                                             |
| `vecs_unwatch`    | `target?`, `watch`                                                                                           | `{ watch }`; releases query, hooks and log                                                                                                                |

See [watches](./watches.md) for event shape, lifetime, costs and resource subscriptions.

Component `kind` is `module` for module definitions, `relationship` for relationship
types, and `component` otherwise, in that precedence order. The separate `trait`
boolean reports explicit membership in `ComponentDef` + `Trait`, not inferred usage.
A relationship can also be a trait. **Output change:** `kind: "trait"` is no longer
returned; check `trait` instead and declare custom traits with the core `Trait` marker.

`traits` is a uniform array of `{ name: string, targets?: (string | { $entity: number })[] }`.
Only attached registered definitions carrying `Trait` appear. Ordinary entries are
`{ name: "Singleton" }` or `{ name: "Implements" }`. Pair-form (relationship) traits
always include every target, e.g. `{ name: "With", targets: ["Position"] }` or
`{ name: "OnSnapshot", targets: ["DontSnapshot"] }`. Targets use the definition's
registry key (including `Name@eid` for duplicates), otherwise `{ $entity: eid }`.
**Output change:** trait entries are objects, not name strings. Entity-keyed
attachments, ordinary definition data and singleton self-carry do not become traits.

`module` names the nearest Module ancestor via `ChildOf`. `carriers`
counts live instances, including infrastructure. Stats tools read existing
`WorldStats` snapshots; they do not turn measurement on.

## Query DSL

`vecs_find` uses one-shot `world.filter`, not a live query. `where` supports:

- A component name, `true`, `false`, or an array (all terms).
- `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": expression }`.
- `{ "only": "Name" }` or `{ "only": ["A", "B"] }` (exact component set).
- `{ "target": ["Relationship", expression] }` and
  `{ "source": ["Relationship", expression] }`.
- `{ "parent": expression }` and `{ "children": expression }` through `ChildOf`.

`test` predicates are not expressible in JSON and are explicitly rejected.
`vecs_watch` shares this translator but rejects `source` and `children` at any
depth because they are filter-only, non-reactive operators. Use `vecs_find` for
those expressions; watches still support `parent`, `target` and the other reactive
operators. See [watches](./watches.md) for their live-query semantics.
Only `include`d component values are projected; omitted `include` produces an
empty components object. Pagination uses nonnegative integer `limit` and `offset`.

For the canonical DSL, `vecs_find` iterates a cached term's membership when one
already exists; otherwise it makes one predicate pass over world entities. It
never creates a term. The walk costs O(matches) with a cached term, otherwise
O(entities × predicate cost), plus O(returned matches × included components) for
projection. Pagination still walks all matches to compute `total`.

Component-name indexes rebuild lazily in O(C) only after definition query entry or
exit; clean lookups are O(1). Component listing inspects definitions and their own
attachments/trait targets, not all potential carriers. Entity inspection visits its
own components and one incoming lookup per relationship definition (O(k + R), plus
returned edges). Mutation preflight uses indexed entity names and batch-local
overrides, visiting only referenced entities' own components.

```json
{ "where": { "all": ["Position", { "not": "Dead" }] }, "include": ["Position"], "limit": 10 }
```

## Mutation operations

Set exactly one action to `true` in each op. `component` and `relationship` are
registered names. `entity` and `to` accept an eid, an Identity name, or `$n`
referencing the nth create in this batch (zero-based, preceding creates only).

| Op           | Shape                                                                           |
| ------------ | ------------------------------------------------------------------------------- |
| Create       | `{ "create": true, "name": "optional name" }`                                   |
| Destroy      | `{ "destroy": true, "entity": 1000 }`                                           |
| Rename       | `{ "name": true, "entity": 1000, "value": "new name" }`                         |
| Add defaults | `{ "add": true, "entity": 1000, "component": "Position" }`                      |
| Merge fields | `{ "set": true, "entity": 1000, "component": "Position", "value": { "x": 2 } }` |
| Remove       | `{ "remove": true, "entity": 1000, "component": "Position" }`                   |
| Link         | `{ "link": true, "entity": 1000, "relationship": "Likes", "to": 1001 }`         |
| Unlink       | `{ "unlink": true, "entity": 1000, "relationship": "Likes", "to": 1001 }`       |

Create an entity with components by following `create` with `add` or `set` ops
using `$0`. A `set` creates a component with defaults if absent. It shallow-merges
`value` through `entity.set`; a nested object replaces the previous object rather
than deep-merging it. Structural checks apply to written keys recursively; whole-draft
validators may enforce completeness or cross-field rules. An `entity`-typed field accepts an existing eid, converted to the
world's Entity instance on write. See [execution](./execution.md) before batching.
