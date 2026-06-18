# Design Rules

vecs has a canonical design guide:
[`lib/vecs/docs/design-guide.md`](../../lib/vecs/docs/design-guide.md). It is the source of
truth for how to model with the ECS — components are data, systems are behavior, and lifecycle
is driven by the presence and change of components, not by imperative bookkeeping — plus the
idioms to reach for and the anti-patterns to avoid.

Read it before:

- Designing or writing vecs **components, systems, modules, queries, or phases** in any
  `lib/vecs*` package.
- Building a **game or application on vecs** (server or client) — the same idioms apply to app
  code, not just library internals.

You do not need it for janitorial work (formatting, renames, dependency bumps, release hygiene)
that does not design or change ECS behavior.

The guide is built to skim: read §1–§2 and the §8 anti-patterns + §9 pitfalls tables for the
fast rules, then deep-read only the section your task touches. Keep the guide itself the single
source of truth — link to it from new docs and tickets instead of restating it.
