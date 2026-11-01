# Settled Decisions

Design decisions the Vecs suite has settled, with the reasoning, so they are not reopened without new
evidence. Planning belongs in [`ROADMAP.md`](./ROADMAP.md), shipped work in
[`CHANGELOG.md`](./CHANGELOG.md).

## `With` adds, never removes

`With` is inclusion, not requirement. Adding the bringer adds the companion; removing the bringer
leaves the companion in place. A companion that must leave with its bringer uses the owning
pair-form trait (`Requires`, working name, pending in
[#463](https://github.com/vworlds/vecs/issues/463) under
[#428](https://github.com/vworlds/vecs/issues/428)) or an explicit `remove` hook on the bringer.
Settled in [#437](https://github.com/vworlds/vecs/issues/437).

**Why.**

- The two lifecycles are different tools. Other engines keep them apart too: Flecs `With` is add-only
  by design, and symmetry is the separate `Symmetric` relationship trait. Bevy required components are
  insert-only, and removal is the explicit `remove_with_requires`;
  [bevyengine/bevy#23393](https://github.com/bevyengine/bevy/issues/23393) (open) proposes splitting
  "included" (current behavior) from "required" (removal cascade) because different uses want
  different behavior.
- The owning form is needed per pair, not per bringer. In-tree,
  `lib/vecs-phaser-server/src/dead_reckoned.ts` hand-writes the removal half for three of the
  five components `DeadReckoned` brings, and deliberately not for `PhysicsRotation`.
- `ClientWorld.apply` already relies on the add-only meaning: a network removal of a component that
  another present component brings is skipped.

**How to apply.** Use `With` when the bringer is never removed from a live entity (it is the entity's
identity, or the entity dies with it), or an orphaned companion is harmless. Otherwise own the
companion explicitly. See the [design guide](../lib/vecs/docs/design-guide.md#component-traits-policy-on-component-entities)
and [`With` in the relationships guide](../lib/vecs/docs/relationships.md#companions-with).
