# Entity Inheritance

Build reusable game templates with `IsA`, choose copy or live inheritance per component, and
override inherited state locally without wrapper objects or inheritance-depth lookup.

## Model

An `IsA` edge gives one entity the effective components of another:

```ts
import { Inherit, IsA, OnInstantiate, World } from "@vworlds/vecs";

class Position {
  x = 0;
  y = 0;
}

class Health {
  current = 100;
}

const world = new World();
world.component(Position).add(OnInstantiate, Inherit);
world.component(Health); // Override is the default

const grunt = world.entity().set(Position, { x: 10 }).set(Health, { current: 50 });
const enemy = world.entity().add(IsA, grunt);

enemy.get(Position) === grunt.get(Position); // true: borrowed
enemy.get(Health) === grunt.get(Health); // false: copied
```

`IsA` is an exclusive relationship: an entity has at most one direct template. Inherited
components are ordinary effective components. `has`, `get`, injection, filters, queries, systems,
grouping, and ordering see them without a special query operator or a chain walk.

The template remains an ordinary entity. It can itself carry `IsA`, so templates compose through
any number of layers. Cycles and self-inheritance throw.

## Choose A Policy

Set policy on the component entity with `OnInstantiate`:

```ts
import { DontInherit, Inherit, OnInstantiate, Override } from "@vworlds/vecs";

world.component(Health).add(OnInstantiate, Override);
world.component(Position).add(OnInstantiate, Inherit);
world.component(RuntimeHandle).add(OnInstantiate, DontInherit);
```

| Policy        | Behavior                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Override`    | Create one shallow local copy when `IsA` is added. This is the default. Later template changes do not affect the copy.                     |
| `Inherit`     | Borrow the template's effective instance. Reconcile template add, update, attach, remove, and re-add operations through every `IsA` layer. |
| `DontInherit` | Do not expose this component through `IsA`.                                                                                                |

Relationships and `Singleton` components are never inherited. `Implements` aliases follow their
concrete component and continue to resolve to the same instance.

Configure policy before creating inheritors. Changing `OnInstantiate` does not rewrite existing
`Override` copies or borrowed slots. A component configured as `Inherit` is also borrowed when the
template gains it after the `IsA` edge exists; `Override` remains an instantiate-time copy policy.

## Override Locally

Local state always wins. A component already owned by the child is not replaced when `IsA` is
added, including a locally owned member of the same exclusive-component group or an implementation
of the same interface.

For `Inherit`, readonly access borrows the source instance. Every mutable vecs API first creates a
shallow local copy:

```ts
const enemy = world.entity().add(IsA, grunt);

enemy.set(Position, { x: 20 });
enemy.get(Position) === grunt.get(Position); // false

grunt.set(Position, { x: 30 });
enemy.get(Position)?.x; // 20: the local override stops propagation
```

The copy-on-write boundary applies to `set`, `attach`, `getMut`, `ensure`, and `modified`. `add(C)`
remains idempotent when `C` is already effective; use `set`, `attach`, or a mutable API to establish
a local value.

Both `Override` and copy-on-write are shallow. Treat borrowed values returned by `get` or injection
as readonly. A direct assignment, including a nested-object mutation, changes the shared source
before vecs can establish a local copy; calling `modified` afterward cannot undo that write. Prefer
small value components and call `getMut`, `ensure`, or `set` before mutation when an entity may
inherit the component.

## Remove And Retarget

Removing an inherited component means "absent on this entity," not "fall back immediately":

```ts
enemy.remove(Position);
grunt.set(Position, { x: 40 });
enemy.has(Position); // false

enemy.set(Position, { x: 5 }); // replace the absence with a local value
```

That absence override lasts until the `IsA` edge is removed or retargeted. It also propagates to
entities that inherit from this entity.

Removing local state has the complementary behavior. Removing a local override, exclusive-group
peer, or competing interface implementation reveals the template's current unblocked `Inherit`
value. An `Override` copy is ordinary local state: removing it leaves it absent, and it is not
recreated until a new `IsA` edge applies the instantiate-time policy.

Removing `IsA` drops all borrowed `Inherit` slots. Local values and `Override` copies remain.
Retargeting with another `add(IsA, nextTemplate)` performs the same cleanup before applying the new
template, so components borrowed only from the old template cannot leak into the new shape.

Destroying a template uses the relationship's `Remove` target-cleanup policy: direct inheritors stay
alive, lose their `IsA` edge, and drop borrowed slots. Their local components remain.

## Changes And Queries

An `Inherit` source change is an effective change on every unshadowed descendant. vecs routes it
through the existing query graph:

```ts
world
  .query("moving enemies")
  .with(Position)
  .update(Position, (entity, position) => {
    // Runs for the template and for each unshadowed inheritor.
    render(entity, position);
  })
  .build();
```

Source addition makes descendants enter component queries. Source removal makes them exit. Source
`set`, `attach`, `modified`, `getMut`, and `ensure` route descendant updates, re-evaluate watched
predicates, and refresh ordering and grouping. A local value or local absence stops propagation for
that branch.

Borrowed slots do not represent ownership. They do not increment `ComponentMeta.usageCount`, and
component `add`, `set`, and `remove` hooks run only for the entity that owns and mutates the source
instance. Descendant query and system updates still run for every affected inheritor. Establishing a
local copy creates an owned component and fires its normal ownership hooks. This keeps hook-driven
resource lifecycle attached to the entity that actually owns the instance.

Reads and query membership remain constant-time at any inheritance depth. Template writes perform
work proportional to the unshadowed descendants they affect because each descendant's queries,
ordering, and grouping must remain correct. Use `Inherit` for definition data with useful shared
updates; prefer `Override` for frequently changing per-instance simulation state.

## Reference

| API                                                  | Meaning                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `entity.add(IsA, template)`                          | Add or replace the exclusive template edge and apply component policies.                           |
| `entity.remove(IsA)`                                 | Remove the edge, borrowed slots, and absence overrides; retain local values and `Override` copies. |
| `entity.target(IsA)`                                 | Return the direct template, or `undefined`.                                                        |
| `template.children(IsA)`                             | Return direct inheritors through the relationship reverse index.                                   |
| `world.component(C).add(OnInstantiate, Override)`    | Select one-time shallow copy. This is the default when no policy edge exists.                      |
| `world.component(C).add(OnInstantiate, Inherit)`     | Select reactive borrowing with shallow copy-on-write through mutable vecs APIs.                    |
| `world.component(C).add(OnInstantiate, DontInherit)` | Exclude the component.                                                                             |
| `InheritanceModule`                                  | Built-in module installed automatically by `World`; exported for custom world composition.         |

`IsA`, `OnInstantiate`, the three policy markers, and `InheritanceModule` are exported from
`@vworlds/vecs`. The implementation lives in `lib/vecs/src/modules/inheritance.ts`; effective-slot
storage and mutation integration live in `lib/vecs/src/entity/entity.components.ts`.
