# Vecs Roadmap

Forward-looking planning for the Vecs suite. Completed work belongs in
[`CHANGELOG.md`](./CHANGELOG.md), not here.

## Version +1

Planned features for the next version.

- [vecs-physics] **Fixed-step driver** — add a small real-time accumulator helper so games can drive deterministic physics without hand-rolling the `requestAnimationFrame` to fixed-timestep bridge.
- [vecs-physics] **Joints** — add the next major physics surface with a second cross-entity relationship model (`JointBodies`) plus per-type joint components.
- [vecs-physics] **Open-chain sharp-endpoint ghost vertices** — replace the reflection approximation at open-chain endpoints with real Box2D ghost-vertex parity so sharp endpoints collide correctly; loop chains already use real neighbor ghosts.
- [vecs] **Injected mutation dirty tracking** — make `.each`/`.update`-injected component mutation reliably mark components modified, or provide an explicit ergonomic replacement if automatic tracking is not viable.
- [vecs-phaser-client] **Parent-relative render transforms** — support render transforms relative to parent entities so scene graphs can express local offsets without manual pose baking.
- [vecs-phaser-client] **Anchored UI and text origins** — add UI anchoring and text-origin controls for screen-space overlays and precise label alignment.
- [vecs-phaser] **Sprite renderables** — add wire-serializable sprite components and matching server/client rendering support alongside the current primitive shapes.
- [vecs-phaser-server] **Effect builders** — add particle/effect-oriented server helpers that create short-lived networked render entities with predictable lifecycle cleanup.

## Version +2

Planned features for the subsequent version.

- [vecs-physics] **Shape casts and character movers** — expose public shape-cast helpers and build character-movement primitives on top of the query foundation.
- [vecs-physics] **Debug draw bridge** — provide geometry callbacks that let callers render Box2D debug data through their own renderer.
- [vecs-physics] **World teardown and serialization** — add explicit Box2D world destruction, pool cleanup, and a rebuild-from-components load path.
- [vecs-physics] **Per-segment chain materials** — let each chain segment carry its own surface material (friction, restitution, rolling resistance, tangent speed) via Box2D's `materials[]`/`materialCount` chain def, instead of one uniform material per chain.
- [vecs-physics] **In-place chain material updates** — bind `b2Chain_SetSurfaceMaterial` in box2d3-wasm and use it to mutate chain materials without recreating the whole chain, the way single shapes already use `b2Shape_SetSurfaceMaterial`.
- [vecs] **Suite-level save/load contracts** — define how core entities, relationships, protocol state, and package-specific components participate in persisted worlds.
- [vecs-phaser-client] **Renderer batching pass** — reduce Phaser object churn and update cost once the render surface settles around primitives, sprites, UI, and effects.
