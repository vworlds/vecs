# Entity Inheritance with `IsA`

Inherit a template entity's components onto another entity with per-component copy, proxy, and skip
policies. Read-through proxies snapshot on first write. No retargeting, no transitive chains, and a
documented stale-proxy caveat when the template is destroyed or its components are removed.

## What `IsA` is

`IsA` is a built-in exclusive `Relationship`. Adding `(IsA, template)` to an entity walks the
template's ordinary components and attaches each onto the inheritor according to that component's
`OnInstantiate` policy:

- **Override** (default): copy the component instance into the inheritor (shallow via
  `Object.assign`).
- **Inherit**: attach a dirty-on-write wrapper that reads through to the template's instance until
  the inheritor writes to any field, at which point it lazily copies and becomes a normal instance.
- **DontInherit**: skip the component entirely.

```ts
import { IsA, OnInstantiate, Inherit, Override, DontInherit, World } from "@vworlds/vecs";

class Helmet {
  armor = 0;
}
class Sword {
  damage = 0;
}
class Faction {
  team = 0;
}
class Horse {
  speed = 0;
}

const world = new World();
world.component(Helmet).add(OnInstantiate, Inherit);
world.component(Sword).add(OnInstantiate, Override);
world.component(Faction).add(OnInstantiate, DontInherit);
world.component(Horse);

const warrior = world
  .entity()
  .set(Helmet, { armor: 3 })
  .set(Sword, { damage: 10 })
  .set(Faction, { team: 1 });
const knight = world.entity().add(IsA, warrior).add(Horse);

warrior.has(Horse); // false
warrior.has(Faction); // true
knight.has(Helmet); // true
knight.has(Sword); // true
knight.has(Horse); // true
knight.has(Faction); // false
```

`IsA` is exclusive: one template per inheritor. `OnInstantiate` is a self-parent `OneOf` enum
relationship, so its targets must be one of the three option entities (`Override`, `Inherit`,
`DontInherit`), which `InheritanceModule` registers as `ChildOf` children of the `OnInstantiate`
component entity.

## `OnInstantiate`: per-component policy

Set the policy by adding an `OnInstantiate` edge to the component entity:

```ts
world.component(Helmet).add(OnInstantiate, Inherit);
world.component(Sword).add(OnInstantiate, Override); // also the default
world.component(Faction).add(OnInstantiate, DontInherit);
```

A component with no `OnInstantiate` edge defaults to `Override`. `OnInstantiate` is `Exclusive`, so
re-adding with a different option atomically replaces the edge — policy switching affects future
`IsA` additions but not already-created inheritors (the copy/proxy is resolved once at `IsA` time).

`OnInstantiate` is a meta-policy: it is never inherited by the `IsA` walk. Relationships
(including `IsA` itself) and `Singleton` components are also skipped.

## Inherit mode: dirty-on-write wrappers

When a component has `OnInstantiate=Inherit`, the `IsA` walk does not copy the component. Instead it
attaches a wrapper — a real instance of the component class (so `instanceof` is preserved) whose
fields read through to the template's instance until the first write:

```ts
warrior.get(Helmet); // { armor: 3 }
knight.get(Helmet); // { armor: 3 } — reads through to warrior

warrior.set(Helmet, { armor: 5 });
knight.get(Helmet); // { armor: 5 } — still reading through

knight.set(Helmet, { armor: 7 });
warrior.get(Helmet); // { armor: 5 }
knight.get(Helmet); // { armor: 7 } — snapshotted, no longer reads through
```

The wrapper snapshots all fields from the template on the first write and stores the new value in
its internal copy. Subsequent reads and writes go to the internal copy. The next `get`, `set`, or
`modified` call promotes the wrapper to a real instance (replacing it in the entity's component
storage), so the snapshot is permanent and the wrapper is gone.

`getMut` and `ensure` also promote the wrapper — they route through `_get`, which performs the
promotion lazily when the wrapper is dirty.

### `instanceof` preservation

```ts
knight.get(Helmet) instanceof Helmet; // true — wrapper or promoted instance
```

The wrapper extends the original component class, so `instanceof` checks pass both before and after
the wrapper is promoted to a real instance.

### `each()` and `modified()`

A system callback that mutates a proxied component dirties the wrapper's internal copy. Call
`e.modified(C)` after the mutation to fire `onSet` and notify watchers — the same contract as
mutating a non-wrapped component in place:

```ts
world
  .system("move")
  .with(Position)
  .each([Position], (e, [pos]) => {
    pos.x++;
    e.modified(Position);
  });
world.progress(0, 0);
```

`modified` promotes the wrapper to a real instance before firing notifications, so observers always
see a normal instance.

### Transitive `IsA` with shortcut collapsing

```ts
const unit = world.entity().set(Position, { x: 5, y: 7 });
const warrior = world.entity().add(IsA, unit);
const knight = world.entity().add(IsA, warrior);
```

`knight`'s wrapper reads directly from `unit`'s instance, not through a chain of
wrappers-of-wrappers. The shortcut collapses clean intermediate wrappers. If an intermediate
wrapper is already dirty (the inheritor has diverged from its template), the new inheritor gets a
real copy of the dirty values instead of a wrapper.

## No retargeting

`IsA` does not allow retargeting — adding a second template to an entity that already has one
throws:

```ts
e.add(IsA, t1);
e.add(IsA, t2); // throws: "IsA does not allow retargeting; remove the existing edge first"
```

Remove the existing edge first with `e.remove(IsA)` or `e.remove(IsA, t1)`. Re-adding the same
template is an idempotent no-op. In deferred mode the throw surfaces from `flush()` /
`progress()`, consistent with other trait-invariant violations.

## Removing `IsA`

`e.remove(IsA)` and `e.remove(IsA, template)` remove the edge and leave the copied or proxied
components on the inheritor. Clean wrappers stay wrappers; dirty wrappers stay wrappers until a
later `get` / `set` / `modified` promotes them. The inherited components become ordinary components
on the inheritor.

## Destroying the template

`IsA` uses `CleanupPolicy.Remove` (the default): destroying a template removes the `IsA` edge from
each inheritor but does **not** destroy the inheritors. Inherited components stay on the inheritor.

Proxies that pointed at the template's instances go stale: they keep reading the last-known values
from the (now-detached) target instances, which remain in memory as long as a wrapper holds a
reference. Writes to a stale clean wrapper snapshot at first write — effectively freezing the
template's last state into the inheritor. This is a documented caveat; no bookkeeping is added to
propagate destruction to every inheritor.

The same caveat applies when a component is removed from the template after `IsA`: the inheritor's
wrapper for that component goes stale and keeps reading the last-known values.

## The `attach` caveat

`entity.attach(C, instance)` is not supported on a component marked `OnInstantiate=Inherit`. It
replaces the instance on the source entity while inheritors hold wrappers pointing at the previous
instance, creating a dangling-proxy hazard. Use `set` or `add` instead. This is a documented
caveat; no runtime guard is installed.

## Teardown

`clearAllEntities` succeeds with `IsA` edges live. The teardown path empties relationships before
firing remove hooks, so the no-retarget guard never fires during world destruction.

## Reference

| API                                             | Description                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `class IsA extends Relationship`                | Built-in exclusive relationship; one template per inheritor.                        |
| `class OnInstantiate extends Relationship`      | Built-in self-parent `OneOf` enum declaring the per-component policy.               |
| `Override`, `Inherit`, `DontInherit`            | Marker classes registered as children of `OnInstantiate`; passed by class to `add`. |
| `world.component(C).add(OnInstantiate, policy)` | Set the `IsA` policy for component `C`. Default is `Override`.                      |
| `e.add(IsA, template)`                          | Walk `template`'s components and copy/proxy/skip each onto `e`.                     |
| `e.remove(IsA)` / `e.remove(IsA, template)`     | Remove the edge; copied/proxied components stay on `e`.                             |
| `e.target(IsA)`                                 | The current template, or `undefined`.                                               |
| `e.children(IsA)`                               | `ReadonlySet<Entity>` of inheritors of `e` (reverse index).                         |
| `ComponentMeta._proxy(c)`                       | Internal: produce a dirty-on-write wrapper around `c`.                              |
| `isWrapperInstance(value)`                      | Internal: type guard for wrapper instances.                                         |
