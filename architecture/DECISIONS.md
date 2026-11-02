# Decisions

Record design decisions that changed course, so a reader of the history knows which choice is current.

Each entry names the decision, the commit or PR that made it, what superseded it and why. Newest
entries come first.

## `update` only watches; `with` alone builds membership

- **Superseded:** `c00c156` (2026-06-11, "refactor: simplify update predicates") made `update(C)`
  append `with(C)`, so a watch also required its component.
- **Current:** `#443` (2026-11-02). `update({ watch: C }, cb)` never touches the predicate,
  the `update(C, cb)` shorthand is removed, and building a query or system that has an `update` but
  no `with` terms throws.
- **Why:** a game that keeps its state in small optional components, as the
  [design guide](../lib/vecs/docs/design-guide.md#3-components) recommends, needed one system per
  watched component. SpaceRocks ran about 24 server systems for 8 functions. Removing the
  shorthand makes every call site say, through `with`, whether the component is required.
  `scripts/codemods/update-explicit-with.mjs` migrates call sites while keeping their meaning.
