# Parenting

How to draw entities relative to other entities: the two display
relationships (`DrawIn`, `DrawBy`), the `Container` renderable, and `Offset`.

## Two relationships, two concerns

`ChildOf` (from `@vworlds/vecs`) is **ownership**: server-local, cascade
lifecycle (destroying the parent destroys the children). `DrawIn`/`DrawBy`
are **display**: networked, and destroying the display parent only detaches
the children (`CleanupPolicy.Remove`). An entity can carry both — a ball's
visual is `ChildOf` the ball (dies with it) _and_ `DrawIn` the ball (drawn
inside its Container).

## The three rendering cases

| Case         | Components on the child                    | How it renders                                                                                                                                                                   |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Root**     | `Position` + renderable                    | On the scene display list; positioned by `phaser.sync.position`. The default.                                                                                                    |
| **Native**   | `Offset` + renderable + `DrawIn → parent`  | Added into the parent's Phaser `Container`; Phaser composes transforms natively — zero per-frame JS. The parent must carry `Container`; the child must **not** have `Position`.  |
| **Computed** | `Offset?` + renderable + `DrawBy → parent` | Stays on the scene root; a client system derives its world `Position` each frame from the parent's interpolated `Position` (+ `Offset`). The derived `Position` is client-local. |

Pick **native** (`DrawIn`) when the child should inherit the parent's full
transform (rotation included) — turrets, orbiting decorations, compound
visuals. Pick **computed** (`DrawBy`) when the child should track the
parent's position but keep its own orientation — name labels, health bars.

```ts
// A label that follows the player but never rotates with it:
world
  .entity()
  .childOf(player) // lifecycle: dies with the player
  .set(DrawBy, { target: player }) // display: tracks its position
  .add(Networked)
  .set(Offset, { x: 0, y: 0.6 })
  .set(Text, { value: "you", fontSize: 12 });
```

```ts
// A compound visual: hull + turret inside one rotating Container body.
const body = world
  .entity()
  .add(Networked)
  .add(Container)
  .set(Position, spawn)
  .set(Rotation, { angle: 0 });
world
  .entity()
  .childOf(body)
  .set(DrawIn, { target: body })
  .add(Networked)
  .set(Rectangle)
  .set(Size, { width: 0.8, height: 0.5 })
  .set(Offset, { x: 0, y: 0 });
world
  .entity()
  .childOf(body)
  .set(DrawIn, { target: body })
  .add(Networked)
  .set(Rectangle)
  .set(Size, { width: 0.5, height: 0.12 })
  .set(Offset, { x: 0.4, y: 0 });
```

## Rules and edge cases

- `DrawIn` and `DrawBy` are mutually exclusive; setting one removes the
  other. Retargeting either is a plain data change (the client reparents).
- **Ghost parents** are handled: if a child arrives before its parent's
  `Container`, its GameObject stays off-display until the Container
  materializes, then gets adopted automatically.
- Destroying a display parent detaches children back to the scene root; if
  they were also `ChildOf` the same parent, the lifecycle cascade destroys
  them first and the detach is a no-op.
- The parent of a `DrawIn` child must be a `Container` entity. A `Container`
  is itself a renderable (exclusive with shapes) — give the parent's own
  visual to a `DrawIn` sub-entity instead.

Bandwidth tip: rotating one parent `Container` (1 f32/tick) is far cheaper
than re-sending positions of N children — the electron orbit in the original
demo and the compound tanks pattern both exploit this. See the
[design guide](./design-guide.md#compose-on-the-server-expand-on-the-client)
for when to reach for parenting vs. client-side expansion.
