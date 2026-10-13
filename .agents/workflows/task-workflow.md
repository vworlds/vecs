# Task workflow (worker agents)

Your task is a draft PR. Its description is your prompt, and `[orchestrator]` comments on it amend
the prompt; where they conflict, the newest wins. Use the comment tags `[worker] DESIGN`,
`[worker] QUESTION`, `[worker] READY FOR REVIEW (round n)` and `[worker] BLOCKED`; orchestrator
responses use `[orchestrator] ANSWER`, `[orchestrator] CHANGES REQUESTED (round n)`,
`[orchestrator] OWNER REVIEW`, `[orchestrator] APPROVED` and `[orchestrator] GO`. A PR marked
`⛔ ON HOLD` must not be started.

Read `AGENTS.md` and the relevant `.agents/rules/*` before starting. Work only in your own worktree
and branch, never in the main checkout, on `dev` or on `master`.

Every step below has a script in `scripts/agent/`. Each takes the PR number; use the scripts instead
of retyping commands.

| Step                                                                                                                                                          | Script                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Prepare your worktree: put the branch on the latest `dev` and `npm ci`. Safe to re-run.                                                                       | `start-task.sh <pr>`                            |
| Read the description and every comment.                                                                                                                       | `read-pr.sh <pr>`                               |
| Push your branch fast-forward only, with retries and an SSH fallback. It refuses an empty branch; if the remote moved, fetch and merge it (never force-push). | `push.sh`                                       |
| Post a comment from a file. It adds `[worker]` if it's missing.                                                                                               | `pr-comment.sh <pr> <file>`                     |
| Wait for CI once; last line is the verdict (exit 0 green, 1 red, 2 no verdict).                                                                               | `wait-checks.sh <pr> [max minutes, default 30]` |
| Block until the orchestrator replies or the PR closes. Safe to re-run.                                                                                        | `wait-review.sh <pr>`                           |

## While working

- Stay in scope. Report unrelated problems instead of fixing them.
- Run `HUSKY=0 npm ci` when preparing the worktree. While iterating, run only the suites your
  change touches; run all required full checks once before READY.
- If the clean solution needs a vecs change, don't work around it. Post `QUESTION: …` saying what
  you need and why, then wait.
- Commits must pass the pre-commit hook. Never use `--no-verify`.
- Run servers on a non-default free port and stop them when you're done. Never kill a process you
  didn't start.

## Submit

1. Re-read the comments, merge `origin/dev` (never rebase or force-push), run the full checks, then
   `push.sh`. Keep the PR in draft. Record command exit codes with `${PIPESTATUS[0]}`.
   Run `wait-checks.sh <pr>` once with a 30-minute timeout, never in a loop. Read its digest;
   don't fetch more logs unless it says a log could not be read. On exit 2 post
   `[worker] BLOCKED: checks gave no verdict` with the last line and stop.
2. Post `[worker] READY FOR REVIEW (round N)` with:
   - what changed and why;
   - deviations from the prompt;
   - evidence: the commands you ran and their counts;
   - CI: `wait-checks.sh`'s exit code and last line;
   - open questions.

   Never claim evidence you didn't produce.

3. Stand by after READY with `wait-review.sh <pr>`, and run it again if your tool times out.

## After a review

- **`CHANGES REQUESTED`:** fix every point, re-check, push, then post READY (round N+1) with a
  point-by-point answer, and wait again.
- **`ANSWER`:** continue.
- **Merged or closed:** stop. `[orchestrator] APPROVED` is acceptance of the delivery; the
  orchestrator will stop your job before merging. The orchestrator may also end your session
  before merging.
