---
name: vecs
description: "Designs, implements, reviews, and debugs games or applications using @vworlds/vecs. Use whenever a task creates or changes vecs components, entities, systems, queries, relationships, modules, phases, lifecycle, networked components, or ECS architecture."
---

# vecs Application Development

Use the documentation shipped with the consuming project's installed `@vworlds/vecs` package.
Those docs match the API version the project actually uses and are the source of truth for vecs
design and behavior.

## Before Working

1. Locate `node_modules/@vworlds/vecs/docs/`. In a workspace or non-npm install, resolve the
   installed `@vworlds/vecs` package and use its adjacent `docs/` directory.
2. Read `docs/design-guide.md` sections 1, 2, 8, and 9 before designing or changing ECS behavior.
3. Read the task-specific sections of that design guide:
   - Components or replicated state: section 3.
   - Systems or queries: section 4.
   - Ordering or timing: section 5.
   - Feature architecture: section 6.
   - Lifecycle and synchronization patterns: section 7.
4. Use `docs/README.md` to select any detailed subsystem guides needed by the task. Read
   `docs/concepts.md` and `docs/execution-model.md` when the design depends on unfamiliar vecs
   behavior.
5. Inspect the consuming project's existing vecs modules and conventions before proposing a new
   pattern.

Do not rely on memory or a different vecs checkout when installed documentation is available.
Confirm exact names and signatures against the installed declarations under
`node_modules/@vworlds/vecs/dist/`.

## Design From ECS Semantics

Start from the vecs golden rule: components are data, systems are behavior, and component presence
and change drive lifecycle.

Before implementing, identify:

- The state represented by each component and whether absence has meaning.
- Which component transition creates, updates, or removes related state or resources.
- Whether the work should react through `enter`, `update`, or `exit` rather than scan every frame.
- Which phase owns the work and what earlier or later phase it must order against.
- Whether an owned target, relationship, trait, grouped query, or attached resource expresses the
  lifecycle better than imperative bookkeeping.
- Whether the feature belongs in a `Module` that owns registration, systems, phases, and policy.

Prefer the idioms in the installed design guide over generic ECS patterns. vecs execution details,
including per-system flushes and reactive inbox routing, are part of the design model.

## Avoid Generic Workarounds

Check the design guide before introducing:

- Side maps keyed by entity id.
- Components containing behavior or broad god-components with optional sentinel fields.
- Per-frame scans for changes that vecs can route reactively.
- Manual lifecycle bookkeeping that duplicates component presence.
- System registration order as a substitute for explicit cross-feature phase ordering.
- Parallel object graphs that duplicate relationships already represented in the ECS.
- Wrapper abstractions that hide normal vecs entities, components, systems, or modules without a
  concrete need.

If the requested design conflicts with a documented vecs invariant, explain the conflict and use
the documented pattern unless the user explicitly chooses otherwise.

## Implement And Verify

1. Reuse existing components and modules where their semantics match; do not reuse them merely
   because their fields look similar.
2. Keep components small data classes and put behavior in systems or narrowly scoped lifecycle
   hooks as directed by the guide.
3. Express cross-feature ordering with phases. Treat same-phase registration order as a local
   implementation detail unless the installed docs explicitly make it part of the design.
4. Test lifecycle transitions, not only steady-state values: entry, mutation, removal, retargeting,
   destruction, and same-tick visibility where relevant.
5. Run the consuming project's typecheck and focused tests. Resolve API uncertainty from the
   installed declarations and docs rather than guessing.

For networking, physics, Phaser, client, or server integration, also inspect the README and
declarations shipped with the corresponding `@vworlds/vecs-*` package.
