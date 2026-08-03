# One-Shot Inheritance

Snapshot a template once with `IsA`, choose copy or shared-instance policy per component, and
understand the intentionally narrow copy-on-write boundary.

## The one-shot model

`IsA` is an exclusive relationship from an instance entity to its immediate template. Adding the
edge snapshots the template's **current effective ordinary components**. The snapshot uses normal
entity operations, so hooks, carriers, aliases, exclusivity, and query entry behave exactly as they
do for an explicit `set` or `attach`.

```ts
import { IsA, World } from "@vworlds/vecs";

class Position {
  x = 0;
  y = 0;
}

const world = new World();
world.component(Position);

const template = world.entity().set(Position, { x: 10, y: 20 });
const instance = world.entity().add(IsA, template);

instance.get(Position); // a shallow copy of template's Position
```

The snapshot is immediate-template only:

- Relationship entries and `Implements` interface-alias scan entries are skipped.
- A component already present on the new child wins and is skipped.
- A missing `OnInstantiate` policy means `Override`.
- Top-down chains are naturally transitive: make `middle IsA root` before `leaf IsA middle`, and
  the leaf sees the middle's already-effective components.
- Leaf-first construction is not backfilled. Later template additions, removals, `set` calls, and
  `attach` calls do not revisit existing children.

`IsA` is acyclic and cannot be explicitly removed or retargeted while both source and target are
alive. Re-adding the current target is an idempotent no-op. Destroying a template destroys its
direct and transitive inheritors because `IsA.meta.onDeleteTarget` is `CleanupPolicy.Delete`.

## Select a component policy

Attach the `OnInstantiate` relationship to a component entity:

```ts
import { DontInherit, Inherit, OnInstantiate, Override } from "@vworlds/vecs";

class Transform {
  x = 0;
}
class Material {
  color = "white";
}
class RuntimeHandle {}

world.component(Transform).add(OnInstantiate, Override); // explicit shallow copy
world.component(Material).add(OnInstantiate, Inherit); // exact template object
world.component(RuntimeHandle).add(OnInstantiate, DontInherit); // absent on the child
```

| Policy                       | IsA-add behavior                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Missing policy or `Override` | Calls normal child `set` with the template instance as props. Construction plus `Object.assign` makes a distinct, shallow copy. |
| `Inherit`                    | Calls normal child `attach` and stores the exact template instance.                                                             |
| `DontInherit`                | Skips the component.                                                                                                            |

`OnInstantiate` is exclusive and `OneOf` its own component entity. The module registers `Override`,
`Inherit`, and `DontInherit` as direct children. Once selected, a policy cannot be removed or changed;
re-adding the selected policy is an idempotent no-op. `Identity` is configured as `DontInherit`, so a
named template keeps its name and name-index entry.

## Copy-on-write for `set`

`Inherit` shares the exact component object. On an existing-value `entity.set(C, props)`, vecs
considers the value inherited only when the entity's direct `IsA` parent stores the same pointer for
`C`. Public `beforeSet` reducers run first without changing stored pointers. If they select a
replacement, that object becomes the branch replacement; otherwise inheritance shallow-clones the
original with `new C()` plus `Object.assign`. It then repoints descendants that still share the
original pointer and applies `props` to the final object. The parent and siblings retain the old
pointer. A repeated `set` after divergence updates the same object.

This behavior is implemented through the public `beforeSet` lifecycle hook. You can use the same
hook for validation or replacement:

```ts
world.component(Position).on("beforeSet", (_entity, current, props) => {
  if (props.x !== undefined && !Number.isFinite(props.x)) {
    throw new Error("Position.x must be finite");
  }

  if (current.x < 0) {
    return Object.assign(new Position(), current);
  }
  return undefined;
});
```

`beforeSet` runs only when `set` targets an existing ordinary component, before any replacement or
`Object.assign`. Its signature is
`(entity, currentComponent, props) => replacementComponent | undefined`. Concrete handlers run in
registration order, then `Implements` alias handlers run in closure order, all sharing one candidate.
A selected replacement must be an instance of the concrete component class, so an alias cannot
replace it with an interface-only object. An unchanged existing object is not class-checked, which
preserves explicit-class attachment of structurally compatible objects. If validation fails or a
handler throws, no candidate is committed, but earlier handler side effects are not rolled back. If
one reentrantly changes the concrete slot, the outer set aborts. After successful reduction, silent replacement
itself emits no structural or value notification; ordinary `onSet` and query-update routing run once
for the final object. Relationship property updates do not use `beforeSet`.

The inheritance COW handler is an ordinary `beforeSet` handler. A later replacement handler can
therefore select a different object after descendants were repointed; handler ordering is the
application's responsibility.

## Deliberate limits

Only two inheritance behaviors are special: the snapshot/link performed when `IsA` is added and
copy-on-write for an existing-value `Entity.set`. Every other mutation is ordinary vecs behavior:

- `attach` can replace a shared pointer, and `remove` can remove it. No inheritance repair follows.
- `getMut`, `ensure`, direct mutation plus `modified`, and mutation of a shared object do not copy.
  If several entities still hold that object, they naturally read the same changed data.
- Component hooks, exclusivity, `Singleton`, `With`, `Implements`, resources, cleanup policy, frozen
  objects, and other ordinary policies are neither suppressed nor special-cased. Their usual
  behavior can break sharing or leave stale pointers.
- Only normal operations route value notifications. Silent copy-on-write descendant repoints do not
  notify queries, hooks, systems, or networking.
- Networking has no inheritance protocol. Replicate the resulting components or relationships
  explicitly if remote worlds need them.
- Deferred `IsA` materialization and copy-on-write use the world's normal FIFO command queue. They
  add no alternate ordering or reconciliation pass. The `set` and `attach` commands appended while
  a deferred IsA edge is materialized apply after commands already in the queue, so they can observe
  component objects changed by those earlier commands. This is queue-time behavior, not a stored
  value snapshot.

This simplicity is intentional. Use `IsA` for construction-time templates, not for a live reactive
prototype graph. See [Components](./components.md) for ordinary lifecycle rules,
[Relationships](./relationships.md) for edge and deletion semantics, and
[Modules](./modules.md#built-in-modules) for automatic module registration.

## Reference

| API                                  | Meaning                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `entity.add(IsA, template)`          | Add the immutable-live template edge and materialize the template's current ordinary components once. |
| `OnInstantiate`                      | Exclusive per-component relationship selecting one policy below.                                      |
| `Override`                           | Distinct shallow copy through normal `set`; also the default when policy is absent.                   |
| `Inherit`                            | Exact object through normal `attach`, with existing-value `set` copy-on-write.                        |
| `DontInherit`                        | Omit the component from IsA materialization.                                                          |
| `component.on("beforeSet", handler)` | Validate or replace an existing ordinary component before `set` assigns props.                        |
| `BeforeSetHandler<C>`                | `(entity, current: C, props: Partial<C>) => C \| undefined`.                                          |
| `InheritanceModule`                  | Automatically registered built-in module implementing this model.                                     |
