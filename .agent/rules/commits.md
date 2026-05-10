# Commit Rules

Use this format for every commit message:

```text
<type>: <subject>

<body>
```

Allowed types:

- `feat`
- `fix`
- `chore`
- `docs`
- `style`
- `refactor`
- `perf`
- `test`
- `build`
- `ci`
- `BREAKING CHANGE`

The subject must be concise, descriptive, and written without a scope. For example, use `fix: handle missing peer connections`, not `fix(server): handle missing peer connections`.

The body must explain what happened in the commit, including the intent, important implementation details, behavioral impact, tests if relevant, and notable risks or limitations.

Output only the commit message when generating or rewriting commit messages.
