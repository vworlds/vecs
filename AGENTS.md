# AGENTS.md

Detailed, tool-agnostic repo instructions live in `.agent/`.

Always read the relevant files before doing the matching work:

- `.agent/rules/commits.md` before writing, generating, rewriting, or making commits.
- `.agent/rules/formatting.md` before editing code, docs, config, or tests.
- `.agent/rules/testing.md` before fixing bugs, adding features, or changing behavior.
- `.agent/rules/box2d-references.md` before cloning Box2D reference sources for vecs-physics work.
- `.agent/workflows/pr-workflow.md` before preparing or creating pull requests.
- `.agent/README.md` before modifying these instructions, and only when explicitly asked to update repo instructions.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
