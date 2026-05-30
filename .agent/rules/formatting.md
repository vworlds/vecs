# Formatting And Linting Rules

Run formatting and linting before committing code changes:

```bash
npm run format
npm run lint
npm run format:check
```

The pre-commit hook runs `npm run typecheck`, `npx lint-staged`, and `npm run format:check`. Do not bypass it unless explicitly instructed.

Formatting is handled by Prettier. Linting is handled by the workspace `lint` scripts. Keep source, tests, docs, and config files formatted consistently with the existing `.prettierrc.json` settings.

When changing only a few files, it is fine to rely on `lint-staged` during commit, but after broad edits or generated formatting changes, run the full repo commands above.

Place future formatting, linting, hook, and CI rules in this file. Keep `AGENTS.md` limited to links and routing guidance.

When writing code, follow the Stepdown Rule, where high level functions or methods appear first, followed by their helper dependencies. Within a class, the order is: public fields, protected fields, private fields, constructors, public methods, protected methods, private methods with Stepdown Rule followed inside these categories and alphabetically ordered to break ties in order
