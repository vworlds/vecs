# Documentation Rules

When adding or changing a feature, public API, or behavior, update both documentation layers in
the same change:

- The inline **JSDoc** on every touched public symbol.
- The relevant prose guide in `lib/vecs/docs/` (or the owning package's docs directory).

When the public surface or the doc set changes, also update the `lib/vecs/README.md` landing page
and the `lib/vecs/docs/README.md` map and reading order.

Ground documentation in code, not comments. Read the source before writing; verify every name,
signature, and behavior claim against the implementation. Treat existing prose and JSDoc as a
draft to confirm, never as a source to copy.

Write examples as real code. Every example must use the actual public API and typecheck against
it. Spot-compile uncertain snippets in a scratch file before committing (do not commit the
scratch file).

Keep a single source of truth. Each fact lives in one doc; other docs cross-link to it with
relative links instead of restating it. Do not duplicate reference material between guides, and
keep JSDoc the exhaustive per-symbol reference while prose docs carry concept, how-to, and woven
reference tables.

Follow the established doc style:

- One topic per file, a descriptive H1, and a one-line "what you'll learn" intro.
- Concise, direct, second-person, imperative voice. Explain the why, not just the what.
- Structure each guide concept → how-to → woven reference. Reference sections use consistent
  method tables or signature blocks matching the other guides.
- Cite source paths (e.g. `lib/vecs/src/world/world.ts`) where they sharpen precision.
- Every relative link must resolve; name a docs folder index `README.md` so GitHub renders it.

Run `npm run format` and `npm run format:check` after editing Markdown; Prettier formats docs.

Place future documentation policy and package-specific conventions in this file.

ECS design diagrams in docs, issues, and PR comments follow
[`lib/vecs/docs/diagrams.md`](../../lib/vecs/docs/diagrams.md).
