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

## Component storage is per component and switches by density

A component's instances and its carrier set live in one `ComponentStore` on its `ComponentTerm`
(`lib/vecs/src/util/component_store.ts`); term membership lives in `DenseEntitySet`
(`lib/vecs/src/util/dense_entity_set.ts`). Both are a native `Map`/`Set` while sparse, and dense
arrays with a flat, id-indexed, identity-checked position array once dense. Promotion happens on
an idle insert: `count * 8 >= highest id + 1`, or at least 8 members and
`count * 8 + 1024 >= highest id + 1`; an idle insert that would stretch a direct set past twice
that bound demotes it. A component term answers `has` from the entity's bitmask, which agrees with
its store at every observable point
([#557](https://github.com/vworlds/vecs/pull/557)). The representation never changes during an
active iteration of the set.
Entities keep only the ordered list of their component ids (`_ceids`). The deferred command queue
and system inboxes are parallel arrays. Settled in
[#543](https://github.com/vworlds/vecs/issues/543).

**Why.**

- Not archetype tables: the `tables` branch regressed `add`/`remove` by up to 297% and
  mixed-entity systems by up to 225% ([#64](https://github.com/vworlds/vecs/issues/64)); the
  [design guide](../lib/vecs/docs/design-guide.md#3-components) asks for many small optional
  components with presence as lifecycle, so structural changes are frequent.
- Not query-aligned instance columns: in the spike they were 30% faster on pure iteration and 28%
  slower under churn, and cannot represent an injected component that is absent
  ([#543](https://github.com/vworlds/vecs/issues/543)).
- Not an id-indexed array for every set: 200 ten-member terms in a 100,000-entity world cost
  932 KB each ([#553](https://github.com/vworlds/vecs/pull/553)).
- Not a paged position index: paging the store cost large worlds 3-13% and `composite` 12-14%
  ([perf runner](https://github.com/vworlds/perf-test/actions/runs/43663493433)), and paging terms
  cost `any-of` static exit a further 40% on the builder
  ([#555](https://github.com/vworlds/vecs/pull/555)).
- Not `Int32Array` for the position array: no gain on reads, about 25% slower under churn in the
  spike ([#543](https://github.com/vworlds/vecs/issues/543)).
- `Term` does not extend the container: measured 20-30% slower on `composite`
  ([#553](https://github.com/vworlds/vecs/pull/553)).
- Density is an invariant, not an entry test: with promotion-only checks, `Query` and `Identity`
  stores promoted on low ids grew to 101,209 slots for about 200 members
  ([#555](https://github.com/vworlds/vecs/pull/555)).
- Not a member-count field on the containers: maintained on every insert and delete it cost
  `composite` 2-7% at 10,000 and 100,000 entities on the builder, and kept only while sparse still
  2-4%, although that variant left the direct insert and delete paths unchanged in source. An
  `each` system's idle test instead reads its root term's container directly, without the query's
  and the term's `count` accessors, which is what an idle system was paying for (14.2 to 9.4 ns per
  idle system, 11.1 on `dev`) ([#562](https://github.com/vworlds/vecs/pull/562)).
- Per-entity component order is kept (`_ceids`), so `toJSON`, snapshots and teardown hooks see
  the order they always did; member order of queries and terms is unspecified unless `orderBy` or
  `cascade` is used (owner, 2026-11-14). The sector bench's ordered fingerprints changed with it
  and its order-independent ones did not
  ([#543](https://github.com/vworlds/vecs/issues/543)).

**How to apply.** Read a component through the store — `_getFromMeta` when a meta is in hand — and
never cache a store's arrays or representation across entities. Iterate members with the live
traversal, never by index. A change to either container or to the promotion constants needs the
[`core-storage` bench](../bench/README.md#core-storage-cases) on the perf runner, including the
300-entity rows and the heap rows, because every earlier variant looked right on one size and wrong
on another; a hot-path function that grows must be checked for lost inlining (`World.entity` fell
out of the budget once, [#555](https://github.com/vworlds/vecs/pull/555)). See [shared component
storage](../lib/vecs/docs/utilities.md#shared-component-storage) for the container semantics. A
micro-benchmark whose hot loop calls an entity mutator at more than one site can land in two JIT
modes about 10% apart: the immediate `set` chain (about 1,470 bytecodes) cannot fit a caller's
inlining budget (920), so the result depends on whether the mutator or the loop is optimised first,
and a small shift on such a row must be checked with `--concurrent-recompilation-delay` across
several processes before it is read as a regression
([#560](https://github.com/vworlds/vecs/pull/560)). `modified` and `add` each have a path that skips
the store read when nothing needs the instance, and promotion zero-fills its position array in one
bulk copy; tests that fail when any single guard is removed protect the first two
(`tests/entity/modified_observers.test.ts`, `tests/entity/add_default.test.ts`).
Paths that run once per system run or once per entity clear and write their slots with a counted
loop, never `Array.prototype.fill`: on Node 24.15 (V8 13.6) the builtin costs about 15 ns per call
over an empty range, 35 ns over one slot and about 2 ns per further slot, where the loop costs
under 1 ns per slot. The inbox clear paid 29 ns per system run and 130 ns per 21 events for it, and
the `Iter` cursor 29 ns per entity ([#562](https://github.com/vworlds/vecs/pull/562)). A reactive system's cost must be read on the reader's own row
as well as the writer's, because events are routed in the writer's flush and replayed and cleared
in the reader's run: a saving in routing can hide a cost in replay (`reader` rows of the
[`core-storage` bench](../bench/README.md#core-storage-cases)).

**Known residuals.** Measured end to end against `dev` on the perf runner after
[#560](https://github.com/vworlds/vecs/pull/560)
([run](https://github.com/vworlds/perf-test/actions/runs/43714619251), [watched
rows](https://github.com/vworlds/perf-test/actions/runs/43731472203)). An immediate `modified` on a
component with fewer than eight carriers that also has an `update` watcher costs 114-119%, about 15
ns: delivering the instance needs a hash lookup in the sparse store, where the previous per-entity
map read an array. Removing it needs a different sparse representation. The same write with no
observer, and every other `update` routing row, is at 67-71%. An entity entering a dynamic `anyOf`
union inside a non-deferred write costs 110%; deferred it is at 95%. A composite query in a world of
a few hundred client-local entities (ids from 10000, which the promotion allowance does not reach)
costs 109%. Plain `set` and `assign` on a rare component, and singleton reads, are at their previous
cost.
