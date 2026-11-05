# Settled Decisions

Design decisions the Vecs suite has settled, with the reasoning, so they are not reopened without new
evidence. Planning belongs in [`ROADMAP.md`](./ROADMAP.md), shipped work in
[`CHANGELOG.md`](./CHANGELOG.md).

## `With` adds, never removes

`With` is inclusion, not requirement. Adding the bringer adds the companion; removing the bringer
leaves the companion in place. A companion that must leave with its bringer uses the owning
pair-form trait `Requires` ([#463](https://github.com/vworlds/vecs/issues/463) under
[#428](https://github.com/vworlds/vecs/issues/428)). Settled in
[#437](https://github.com/vworlds/vecs/issues/437).

**Why.**

- The two lifecycles are different tools. Other engines keep them apart too: Flecs `With` is add-only
  by design, and symmetry is the separate `Symmetric` relationship trait. Bevy required components are
  insert-only, and removal is the explicit `remove_with_requires`;
  [bevyengine/bevy#23393](https://github.com/bevyengine/bevy/issues/23393) (open) proposes splitting
  "included" (current behavior) from "required" (removal cascade) because different uses want
  different behavior.
- The owning form is needed per pair, not per bringer. In-tree,
  `lib/vecs-phaser-server/src/dead_reckoned.ts` hand-wrote the removal half for three of the
  five components `DeadReckoned` brought, and deliberately not for `PhysicsRotation`.
- `ClientWorld.apply` already relies on the add-only meaning: a network removal of a component that
  another present component brings is skipped.

**How to apply.** Use `With` when the bringer is never removed from a live entity (it is the entity's
identity, or the entity dies with it), or an orphaned companion is harmless. Otherwise declare the
pair with `Requires`. See the [design guide](../lib/vecs/docs/design-guide.md#component-traits-policy-on-component-entities)
and [`With` and `Requires` in the relationships guide](../lib/vecs/docs/relationships.md#companions-with-and-requires).

## `update` only watches; `with` alone builds membership

`update({ watch: C }, cb)` never touches the predicate: `with(...)` is the only way to require a
component, the `update(C, cb)` shorthand is gone, and building a query or system that has an
`update` but no `with` terms throws. This supersedes `c00c156` (2026-06-11, "refactor: simplify
update predicates"), which made `update(C)` append `with(C)`. Settled in
[#443](https://github.com/vworlds/vecs/issues/443), which absorbed
[#492](https://github.com/vworlds/vecs/issues/492).

**Why.**

- A game that keeps its state in small optional components, as the
  [design guide](../lib/vecs/docs/design-guide.md#3-components) recommends, needed one system per
  watched component while a watch also required it. SpaceRocks ran about 24 server systems for 8
  functions.
- Removing the shorthand makes every call site say, through `with`, whether the watched component
  is required.

**How to apply.** Put `C` in `with` when the system should hold only entities that carry it; leave it
out and watch with `onEnter`/`onRemove` when the system holds its `with` entities either way. Migrate
older call sites with the [migration script from v1.0.63](https://github.com/vworlds/vecs/blob/v1.0.63/scripts/codemods/update-explicit-with.mjs), which keeps their meaning. See
[`with` builds membership, `update` watches](../lib/vecs/docs/design-guide.md#with-builds-membership-update-watches).
