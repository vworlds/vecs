# Body Enabled And Type Changes Leave Shape Proxies Stale

## What is wrong

Shape broad-phase proxies are not synchronized with body enabled/type changes.

There are three related failures:

- Shapes are given proxies even when their parent body is created disabled.
- Disabling an existing body moves the body to the disabled solver set but leaves all child proxies active in the broad phase.
- Changing a body's type updates the solver set and `InternalBody.type`, but existing child proxies remain in the old body-type tree and keep the old static/dynamic fat-AABB policy.

## Why it is wrong

The broad phase has one tree per active body type and no disabled tree. Disabled bodies should not contribute candidate collision pairs. When an enabled body changes type, every shape proxy has to move to the tree for the new type.

Box2D handles this explicitly:

- `box2d/src/shape.c:173-177` skips proxy creation when the body is in the disabled set.
- `box2d/src/body.c:1253-1263` destroys and recreates all shape proxies during `b2Body_SetType`.
- `box2d/src/body.c:1610+` and `1680+` destroy proxies on disable and recreate them on enable.

The M1 implementation deferred the broad-phase parts because proxies did not exist yet. M2 added proxies, but the body lifecycle path was not revisited.

## Impacted code

- `src/systems/shape_lifecycle.ts:434-438` creates chain segment proxies without checking whether the parent body is disabled.
- `src/systems/shape_lifecycle.ts:512-523` creates single-shape proxies without checking whether the parent body is disabled.
- `src/systems/lifecycle.ts:127-148` transfers bodies between solver sets and updates `record.type`, but never destroys, creates, or migrates child shape proxies.
- `src/engine/broad_phase.ts:130-140` buffers every non-static proxy it is asked to create, so disabled dynamic bodies can immediately emit pairs.

## Impacted features

- Collision filtering for disabled bodies.
- M3 contact creation from broad-phase pairs.
- Static-to-dynamic or dynamic-to-static body changes.
- Enabling/disabling bodies at runtime.
- Fat-AABB margins, because static proxies use no motion margin while kinematic/dynamic proxies do.

## How to reproduce

Disabled creation case:

1. Create body A with `Body { type: Dynamic, enabled: false }`.
2. Add a child `Box` to body A.
3. Create overlapping enabled dynamic body B with a child `Box`.
4. Progress once.
5. Call `state.broadPhase.updatePairs(...)` from a test.

Expected: no pair involving body A, because disabled bodies do not have proxies.

Current behavior: body A's shape has an active dynamic proxy and can emit a pair.

Type migration case:

1. Create a static body with a child shape and progress once.
2. Change `Body.type` to `Dynamic` and progress again.
3. Inspect the shape `proxyKey` lower bits or broad-phase tree behavior.

Expected: the proxy is recreated in the dynamic tree and buffered for pair creation.

Current behavior: the proxy key still identifies the original static tree.

## Possible solutions

Centralize body-owned proxy synchronization:

- On shape enter, create a proxy only when `bodyRec.setIndex !== DISABLED_SET`.
- On body disable, walk `shapeHead` and destroy every proxy, setting `shape.proxyKey = -1`.
- On body enable, walk `shapeHead`, recompute each world/fat AABB, and create proxies in the current body type tree.
- On body type change while enabled, destroy and recreate every child proxy in the new type tree, with pair creation forced/buffered so contacts can be rebuilt.

Add tests for disabled-body creation, disable/enable after shape creation, and static/dynamic type migration.
