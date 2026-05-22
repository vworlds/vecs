# Materials And Filters

This page covers shape material properties and collision filtering in `vecs-physics`: when to add `Material`, when to add `CollisionFilter`, what defaults are used when they are missing, and how changes affect live shapes.

Materials control how a shape behaves physically. Filters control which other shapes it can collide with.

## Core Concepts

`Material` and `CollisionFilter` are optional components placed on shape entities.

```ts
world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, { density: 1, friction: 0.6 })
  .set(CollisionFilter, { categoryBits: 0b0010n });
```

If either component is missing, `vecs-physics` uses Box2D-compatible defaults. A bare shape is still physical, has mass, has friction, and collides with everything.

```ts
world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

That shape uses:

- Density `1`.
- Friction `0.6`.
- Restitution `0`.
- Category bits `1`.
- Mask bits `0xffff_ffff_ffff_ffffn`.
- Group index `0`.

## Material

`Material` controls density and surface behavior.

```ts
export class Material {
  density = 1;
  friction = 0.6;
  restitution = 0;
  rollingResistance = 0;
  tangentSpeed = 0;
  userMaterialId = 0n;
}
```

| Property | Default | Description |
| --- | ---: | --- |
| `density` | `1` | Shape density in kilograms per square meter. Dynamic body mass is computed from shape density and geometry. |
| `friction` | `0.6` | Coulomb friction coefficient. Higher values resist sliding. |
| `restitution` | `0` | Bounciness. `0` means no bounce. Higher values preserve more collision energy. |
| `rollingResistance` | `0` | Resistance to rolling motion. Usually left at `0` unless modelling wheels or round objects. |
| `tangentSpeed` | `0` | Surface tangent speed, useful for conveyor belts. |
| `userMaterialId` | `0n` | Application-defined material id. Used by custom material logic when supported. |

### Minimal Material Example

```ts
const ball = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(ball)
  .set(Circle, { radius: 0.5 })
  .set(Material, {
    density: 1,
    friction: 0.2,
    restitution: 0.8,
  });
```

This creates a light, slippery, bouncy circle.

### Static Ground Example

Static bodies do not need density for movement, but shape material still matters for contacts with dynamic bodies.

```ts
const ground = world
  .entity()
  .set(Position, { x: 0, y: -1 })
  .add(Body);

world
  .entity()
  .setParent(ground)
  .set(Box, { hx: 25, hy: 1 })
  .set(Material, {
    friction: 0.9,
    restitution: 0,
  });
```

This ground is high-friction and non-bouncy.

### Conveyor Surface Example

`tangentSpeed` can model a moving surface such as a conveyor belt.

```ts
world
  .entity()
  .setParent(conveyorBody)
  .set(Box, { hx: 4, hy: 0.25 })
  .set(Material, {
    friction: 0.8,
    tangentSpeed: 2,
  });
```

The exact direction depends on the shape/contact orientation. Use debug drawing or a small test scene when tuning conveyor behavior.

## CollisionFilter

`CollisionFilter` controls collision categories, masks, and groups.

```ts
export class CollisionFilter {
  categoryBits = 1n;
  maskBits = 0xffff_ffff_ffff_ffffn;
  groupIndex = 0;
}
```

| Property | Default | Description |
| --- | ---: | --- |
| `categoryBits` | `1n` | What this shape is. Usually one bit, such as player, enemy, terrain, or trigger. |
| `maskBits` | `0xffff_ffff_ffff_ffffn` | What this shape accepts collisions with. Default accepts all categories. |
| `groupIndex` | `0` | Optional override. Matching positive groups always collide. Matching negative groups never collide. `0` means no group override. |

Two shapes can collide when both masks accept the other shape's category.

```ts
const canCollide =
  (shapeA.categoryBits & shapeB.maskBits) !== 0n &&
  (shapeB.categoryBits & shapeA.maskBits) !== 0n;
```

If two shapes have the same non-zero `groupIndex`, group filtering overrides category/mask filtering:

- Same positive group: always collide.
- Same negative group: never collide.

## Category And Mask Example

Define category constants in application code.

```ts
const CollisionCategory = {
  Terrain: 0b0001n,
  Player: 0b0010n,
  Enemy: 0b0100n,
  Pickup: 0b1000n,
} as const;
```

Player shape collides with terrain, enemies, and pickups.

```ts
world
  .entity()
  .setParent(player)
  .set(Box, { hx: 0.5, hy: 1 })
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Player,
    maskBits:
      CollisionCategory.Terrain |
      CollisionCategory.Enemy |
      CollisionCategory.Pickup,
  });
```

Terrain collides with players and enemies.

```ts
world
  .entity()
  .setParent(ground)
  .set(Box, { hx: 25, hy: 1 })
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Terrain,
    maskBits: CollisionCategory.Player | CollisionCategory.Enemy,
  });
```

Pickups overlap players only when paired with a sensor shape.

```ts
world
  .entity()
  .setParent(pickup)
  .set(Circle, { radius: 0.25 })
  .add(Sensor)
  .add(SensorEvents)
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Pickup,
    maskBits: CollisionCategory.Player,
  });
```

## Group Index Example

Use a negative group index to prevent shapes in the same group from colliding with each other. This is useful for compound actors, ragdolls, or equipment attached to a player.

```ts
const playerSelfCollisionGroup = -1;

world
  .entity()
  .setParent(player)
  .set(Box, { hx: 0.5, hy: 1 })
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Player,
    maskBits: 0xffff_ffff_ffff_ffffn,
    groupIndex: playerSelfCollisionGroup,
  });

world
  .entity()
  .setParent(player)
  .set(Circle, { radius: 0.25 })
  .set(ShapePosition, { x: 0, y: 1.1 })
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Player,
    maskBits: 0xffff_ffff_ffff_ffffn,
    groupIndex: playerSelfCollisionGroup,
  });
```

Those two shapes do not collide with each other because they share the same negative group.

## Live Updates

Changing `Material` or `CollisionFilter` on an existing shape updates the simulation.

```ts
shapeEntity.set(Material, { friction: 0.1 });
shapeEntity.set(CollisionFilter, { maskBits: CollisionCategory.Terrain });
```

Material updates are usually cheap, but density changes can update body mass.

Filter updates can be expensive because contacts may be destroyed and recreated. Avoid changing filters every frame unless you have measured the cost.

If you mutate a material or filter through `getMut`, Vecs marks it modified automatically.

```ts
const material = shapeEntity.getMut(Material);
if (material) {
  material.friction = 0.2;
}
```

If you mutate a component returned by `get`, Vecs does not know it changed. Use `set`, `getMut`, or call `modified` yourself.

```ts
const filter = shapeEntity.get(CollisionFilter) as CollisionFilter | undefined;
if (filter) {
  filter.maskBits = CollisionCategory.Terrain;
  shapeEntity.modified(CollisionFilter);
}
```

## Defaults Without Components

You do not need to add `Material` or `CollisionFilter` for normal collisions.

```ts
world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

This is equivalent to:

```ts
world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, {
    density: 1,
    friction: 0.6,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    userMaterialId: 0n,
  })
  .set(CollisionFilter, {
    categoryBits: 1n,
    maskBits: 0xffff_ffff_ffff_ffffn,
    groupIndex: 0,
  });
```

The explicit form is only needed when you want different behavior.

## Common Mistakes

### Assuming missing CollisionFilter means no collisions

Missing `CollisionFilter` means collide with everything, not collide with nothing.

Use `maskBits: 0n` only when you intentionally want no category-based collisions.

```ts
shapeEntity.set(CollisionFilter, {
  categoryBits: 1n,
  maskBits: 0n,
});
```

### Setting only one side of the mask

Collision requires both shapes to accept each other. If players should collide with enemies, the player mask must include enemies and the enemy mask must include players.

### Forgetting that sensors still use filters

`Sensor` disables collision response, but filters still decide which overlaps are considered.

```ts
trigger
  .add(Sensor)
  .add(SensorEvents)
  .set(CollisionFilter, {
    categoryBits: CollisionCategory.Pickup,
    maskBits: CollisionCategory.Player,
  });
```

### Changing filters every frame

Changing a filter on a live shape can destroy contacts and create new ones on a later step. Prefer stable categories and masks. Use sensors, events, or gameplay checks when possible.

### Expecting restitution to make perfect bounces

`restitution` controls bounciness, but real results also depend on solver settings, timestep, shape geometry, and collision speed. Start with values below `1` and tune in a test scene.

## Related Pages

- [Shapes](./shapes.md) - shape entities and geometry components.
- [Bodies](./bodies.md) - dynamic body mass, velocity, sleep, and body tuning.
- [Events](./events.md) - contact, sensor, and hit event components.
- [Debug Validation](./debug-validation.md) - optional warnings for invalid component combinations.
