# Entity Inheritance with `IsA`

Inherit a template entity's components onto another entity with per-component copy, live-mirror,
and skip policies. Inherited components are ordinary instances — no proxies — and `Inherit`-marked
components stay in sync with the template until the inheritor writes its own value.

## What `IsA` is

`IsA` is a built-in exclusive `Relationship`. Adding `(IsA, template)` to an entity walks the
template's ordinary components and instantiates each onto the inheritor according to that
component's `OnInstantiate` policy:

- **Override** (default): copy the component instance onto the inheritor once (shallow via
  `Object.assign`). The copy is independent afterwards.
- **Inherit**: copy the component instance onto the inheritor and keep it **live**: value changes,
  later additions, and removals on the template propagate to the inheritor until the inheritor
  writes its own value for that component.
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

There are no wrapper or proxy objects anywhere in the design: every inherited component is a real
instance of its class stored on the inheritor. `instanceof` holds trivially, queries and `has`
match inherited components like any other, and `get` never returns a special object.

## `OnInstantiate`: per-component policy

Set the policy by adding an `OnInstantiate` edge to the component entity:

```ts
world.component(Helmet).add(OnInstantiate, Inherit);
world.component(Sword).add(OnInstantiate, Override); // also the default
world.component(Faction).add(OnInstantiate, DontInherit);
```

A component with no `OnInstantiate` edge defaults to `Override`. `OnInstantiate` is `Exclusive`,
so re-adding with a different option atomically replaces the edge. Switching applies to future
`IsA` edges; switching a component away from `Inherit` also stops live mirroring for its existing
inheritors, which keep their current values.

`OnInstantiate` is a meta-policy: it is never inherited. Relationships (including `IsA` itself),
`Singleton`-marked components, the `Singleton` marker, and interface aliases are also skipped —
attaching the concrete component re-exposes its
[interface aliases](./components.md#interface-aliases-with-implements) on the inheritor
automatically.

A component the inheritor already carries always wins: instantiation never overwrites it, so
`world.entity().set(Helmet, { armor: 8 }).add(IsA, warrior)` keeps `armor: 8`.

## Inherit mode: live mirroring

When a component has `OnInstantiate=Inherit`, the inheritor's copy mirrors the template until the
inheritor diverges by writing its own value:

```ts
warrior.get(Helmet); // { armor: 3 }
knight.get(Helmet); // { armor: 3 } — mirrored copy

warrior.set(Helmet, { armor: 5 });
knight.get(Helmet); // { armor: 5 } — still mirroring

knight.set(Helmet, { armor: 7 }); // knight diverges
warrior.get(Helmet); // { armor: 5 }
knight.get(Helmet); // { armor: 7 }

warrior.set(Helmet, { armor: 9 });
knight.get(Helmet); // { armor: 7 } — diverged, no longer mirroring
```

Divergence is tracked per component on the `IsA` edge, so writing `Helmet` does not stop other
`Inherit`-marked components from mirroring. Any write counts: `set`, `attach`, `getMut`, `ensure`,
or an in-place mutation followed by `modified` — the same operations that notify watchers of a
non-inherited component.

Propagated changes are delivered through the normal notification path: `set` hooks fire and
`update` query callbacks run on each mirroring inheritor, so reactive systems observe inherited
changes exactly like direct ones.

### Live additions and removals

`Inherit`-marked components mirror structure as well as values. Adding one to the template after
the `IsA` edge exists attaches a mirroring copy to every inheritor that does not already carry the
component, and removing one from the template removes it from every inheritor that has not
diverged:

```ts
class Shield {
  block = 0;
}
world.component(Shield).add(OnInstantiate, Inherit);

const scout = world.entity().add(IsA, warrior);
warrior.set(Shield, { block: 2 });
scout.has(Shield); // true — mirrored on addition

warrior.remove(Helmet);
scout.has(Helmet); // false — removed with the template's
knight.has(Helmet); // true — knight diverged earlier and keeps its copy
```

`Override`-marked components do not mirror: they are copied only when the `IsA` edge is created,
and later additions, changes, or removals on the template leave existing inheritors untouched.

### Mutating inside systems

Mutate a component in a system callback and call `modified` to notify watchers — the standard
contract. On a template, the notification also propagates the new values to its inheritors:

```ts
world
  .system("harden")
  .with(Helmet)
  .each([Helmet], (e, [helmet]) => {
    helmet.armor++;
    e.modified(Helmet);
  });
world.progress(0, 0);
```

Without `modified`, an in-place mutation is invisible to watchers _and_ to inheritors — mirroring
rides the same notifications the rest of vecs uses, so there is no way to observe a template state
that watchers have not been told about.

## Transitive `IsA` chains

```ts
const unit = world.entity().set(Position, { x: 5, y: 7 }); // Position is Inherit
const warrior = world.entity().add(IsA, unit);
const knight = world.entity().add(IsA, warrior);
```

Each entity in the chain holds a real copy, and changes cascade level by level: `unit.set(Position)`
updates `warrior`'s copy, which updates `knight`'s. Divergence works the same way per level — if
`warrior` writes its own `Position`, it stops mirroring `unit` but keeps propagating its own values
to `knight`. Adding an `IsA` edge to an entity that already has inheritors cascades the newly
inherited components down the chain, and cyclic `IsA` edges are tolerated (propagation visits each
entity once).

## Retargeting

Adding a different template replaces the edge atomically:

```ts
e.add(IsA, warrior);
e.add(IsA, mage); // retarget
```

On retarget, components still mirrored from the old template are shed (removed from `e` and from
any of `e`'s own inheritors still mirroring them), and the new template is instantiated in their
place. Diverged components and own components — including `Override` copies, which become own
components at instantiation — are kept. Re-adding the same template is an idempotent no-op.

## Removing `IsA`

`e.remove(IsA)` and `e.remove(IsA, template)` remove the edge and leave every copied or mirrored
component on the inheritor as an ordinary own component holding its current values. Later changes
to the former template no longer propagate.

## Destroying the template

`IsA` uses `CleanupPolicy.Remove` (the default): destroying a template removes the `IsA` edge from
each inheritor but does **not** destroy the inheritors. As with `remove`, every inherited component
stays behind as an ordinary own component holding the template's last propagated values. Nothing
dangles: no references to the destroyed template's instances survive on the inheritors.

## Reference

| API                                             | Description                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `class IsA extends Relationship`                | Built-in exclusive relationship; one template per inheritor.                          |
| `class OnInstantiate extends Relationship`      | Built-in self-parent `OneOf` enum declaring the per-component policy.                 |
| `Override`, `Inherit`, `DontInherit`            | Marker classes registered as children of `OnInstantiate`; passed by class to `add`.   |
| `world.component(C).add(OnInstantiate, policy)` | Set the `IsA` policy for component `C`. Default is `Override`.                        |
| `e.add(IsA, template)`                          | Instantiate `template`'s components onto `e` per policy; retargets if an edge exists. |
| `e.remove(IsA)` / `e.remove(IsA, template)`     | Remove the edge; copied/mirrored components stay on `e` as own components.            |
| `e.target(IsA)`                                 | The current template, or `undefined`.                                                 |
| `e.children(IsA)`                               | `ReadonlySet<Entity>` of inheritors of `e` (reverse index).                           |
