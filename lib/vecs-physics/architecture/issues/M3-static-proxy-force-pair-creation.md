# M3: Newly-created static proxies do not force pair creation

## Summary

Adding a static shape after another enabled shape already exists does not buffer the
new static proxy for pair creation. Box2D's default `b2ShapeDef` sets
`invokeContactCreation = true`, and `b2BroadPhase_CreateProxy` buffers even static
proxies when that flag is set. vecs-physics currently never exposes or applies that
force-pair path, so contacts can be missed until some non-static proxy moves.

## What is wrong

`PhysicsShapeLifecycle.enter` creates broad-phase proxies without a force-pair
option:

- single shapes: `src/systems/shape_lifecycle.ts:477-485`;
- chain segments: `src/systems/shape_lifecycle.ts:377-385`.

`BroadPhase.createProxy` then buffers only non-static proxies:

- `src/engine/broad_phase.ts:130-140` creates the tree leaf and skips
  `_bufferMove` when `bodyType === STATIC_BODY`.
- The comment at `src/engine/broad_phase.ts:134-137` says the missing
  `forcePairCreation` path lands in M3, but M3 did not add it.

Box2D does force pair creation for default-created shapes:

- `box2d/src/types.c:57-65` sets `def.invokeContactCreation = true` in
  `b2DefaultShapeDef()`.
- `box2d/src/shape.c:173-176` passes `def->invokeContactCreation || def->isSensor`
  into `b2CreateShapeProxy`.
- `box2d/src/broad_phase.c:104-112` buffers the proxy when
  `proxyType != b2_staticBody || forcePairCreation`.

## Why it is wrong

M3 contact creation only happens through `state.broadPhase.updatePairs(...)` in
`engineStep` (`src/engine/step.ts:40-44`). `updatePairs` only queries buffered
proxies. If a new static shape overlaps an existing dynamic or kinematic proxy, but
the static proxy is not buffered, no pair is emitted solely because the static shape
was added.

This violates the Box2D default shape contract and the M2 handoff, which carried
`forcePairCreation` for static shape contact creation into M3. It is also distinct
from the existing live-contact invalidation issue: that issue covers stale contacts
and enable/type proxy transitions; this issue covers first-time contacts for newly
created static shapes.

## Impacted code

- `src/engine/broad_phase.ts:130-140` lacks a `forcePairCreation` parameter and
  skips buffering static proxies.
- `src/systems/shape_lifecycle.ts:477-485` creates single-shape proxies without
  forcing pair creation.
- `src/systems/shape_lifecycle.ts:377-385` creates chain-segment proxies without
  forcing pair creation.
- `src/systems/lifecycle.ts:219-228` recreate-on-enable/type-change likely needs
  the same force-pair option once that path is fixed.

## Impacted features

Runtime creation of static geometry after dynamic/kinematic shapes exist. Examples:
streaming in terrain tiles, spawning a wall under a resting or moving body, or
creating a static sensor/trigger once sensors land in M4.

## How to reproduce

Create a dynamic body first, let its proxy be created and the move buffer drain,
then add an overlapping static body/shape without moving the dynamic body:

```ts
const world = new World();
installPhysics(world);
world.start();

const dynamicBody = world
  .entity()
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 0, y: 0 });
world.entity().set(ChildOf, { target: dynamicBody }).set(Box, { width: 2, height: 2 });

world.progress(16, 16); // dynamic proxy's initial move buffer is consumed

const staticBody = world
  .entity()
  .set(Body, { type: BodyType.Static })
  .set(Position, { x: 0, y: 0 });
world.entity().set(ChildOf, { target: staticBody }).set(Box, { width: 2, height: 2 });

world.progress(32, 16); // static proxy was not buffered, so the overlap may not create a contact
```

If the dynamic body later moves or its proxy is enlarged/moved, the contact can be
created then, which masks the bug in gravity-driven tests. The missed case is a
new static proxy whose overlap should be evaluated immediately.

## Possible solution

Add a `forcePairCreation` boolean to `BroadPhase.createProxy`, defaulting to
`false` only where the caller intentionally wants old VP-10 behavior. Buffer the
proxy when `bodyType !== STATIC_BODY || forcePairCreation`.

Shape creation should pass `true` to match Box2D's default
`invokeContactCreation`. Enable/type-change proxy recreation should also pass
`true`, matching `b2Body_Enable` and `b2Body_SetType`. Once sensors land, sensor
proxy creation should force pair creation as Box2D does with
`def->invokeContactCreation || def->isSensor`.
