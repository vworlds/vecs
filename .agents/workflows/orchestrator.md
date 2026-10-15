# Orchestrator workflow

The orchestrator owns `dev`. It develops issues with the owner until they are agreed, turns approved
issues into task PRs, reviews them, and merges them. It doesn't write feature code. Every mechanical step is a script in `scripts/orchestrator/`; all of
them retry transient GitHub errors and fall back to SSH when HTTPS pushes fail.
Validate every Markdown body before posting it to GitHub.

| Step                                                                                                                                                                                                                                                                                               | Script                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Open a task PR: a placeholder branch named `<pr>-<words>` (workers use `.worktrees/auto-<branch>`) plus a draft PR whose body points at the task workflow, `Closes #<issue>` and the task file. `--spec` replaces the issue's body; `--part` is for a PR that is not the issue's last. Idempotent. | `open-task.sh <issue> <task.md> [--spec spec.md] [--part] [--slug s]`, `open-task.sh --direct "<title>" <task.md>` |
| Lift a hold and post `[orchestrator] GO`.                                                                                                                                                                                                                                                          | `release-hold.sh <pr> [note.md]`                                                                                   |
| Start a worker in a task PR's worktree, resume or steer it with a new message, see whether it runs and what it did, stop it.                                                                                                                                                                       | `worker.sh start <worktree> <prompt.md>`, `worker.sh send\|status\|log\|stop\|wait\|permit <session or worktree>`  |
| Watch task PRs (READY, QUESTION, pick-ups, stale reviews, merges), the board and what is assigned to you.                                                                                                                                                                                          | `watch-prs.sh` (`ONESHOT=1` to return after the first event)                                                       |
| Test-merge one or more PRs onto `dev`, then run every check; `--packages "<ws> <ws>…"` limits only tests, and `--bench` runs the sector benchmark.                                                                                                                                                 | `verify.sh [--bench] [--packages "<ws> <ws>…"] <pr>…`                                                              |
| Squash-merge by default, close the task's issue, delete the branch, fast-forward the main checkout. Idempotent. Use `--merge-commit` for integration packs; `pack/*` heads are kept unless `--delete-branch` is also given.                                                                        | `merge-task.sh <pr> [--merge-commit] [--delete-branch] [--subject s] [--body-file f]`                              |
| Read the board, move a card, say whose move it is, read or set what blocks an issue, open an issue and add it to Backlog, or archive old Done cards.                                                                                                                                               | `board.sh list\|move\|next\|mine\|turn\|blocked\|block\|unblock\|issue\|remove\|archive`                           |
| Post a review outcome or a reply on a PR or an issue, move its card and set whose move it is.                                                                                                                                                                                                      | `review.sh <pr or issue> changes\|owner\|approve\|answer\|ask <comment.md>`                                        |

Worker branches are updated by fast-forward-only pushes; if a remote branch moved, workers fetch and merge it, never force-push. `verify.sh` removes `lib/*/dist` and `apps/*/dist` after assembling the review merge so checks begin without stale build output, as in CI.

CI and stress jobs use the `CI_RUNNER` repository variable; publishing uses `CI_RELEASE_RUNNER`. Set either to `self-hosted` to select the organisation's runners. Delete the variable to fall back to `ubuntu-latest` (the workflow default).

## The board

The owner tracks all work on the shared GitHub project
[vworlds](https://github.com/orgs/vworlds/projects/4). A card is an issue or a PR. Act on
`vworlds/vecs` cards, and on another repository's cards only when they are assigned to you. Answer
on that card. `board.sh mine` lists those too, and the watcher reports them as `ASSIGNED repo#n`.

**An issue is where an idea is developed and agreed. A PR is where one delivery of it is built and
checked.** The columns mean different things for each:

| Column      | An issue                                                                                        | A PR                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Backlog     | An idea or a ticket, possibly one vague line. Nobody works on it.                               | —                                                                              |
| Ready       | The owner wants it developed, in priority order. One that another open issue blocks waits here. | —                                                                              |
| In review   | Being developed in conversation on the issue, until the owner agrees with what it says.         | A delivery being checked: by you, or by the owner when it is assigned to them. |
| Approved    | The owner agrees with what the issue says. Open its task PR.                                    | The owner agrees with the delivery. Re-verify and merge.                       |
| In progress | Its PRs are open. It waits here until they close.                                               | A worker is building it.                                                       |
| Done        | Closed by the merge of its last PR, or closed as not planned.                                   | Merged or closed.                                                              |

```mermaid
stateDiagram-v2
    direction LR
    state "An issue" as I {
        Backlog --> Ready: owner
        Ready --> Developing: take the first unblocked one
        Developing --> Developing: conversation, assignee flips
        Developing --> Agreed: owner
        Agreed --> Waiting: open the task PR
        Waiting --> Closed: last PR merged
    }
    state "A PR" as P {
        Building --> Checking: worker READY
        Checking --> Building: changes requested
        Checking --> Checking: assigned to the owner, and back
        Checking --> Accepted: owner
        Checking --> Accepted: owner approves
        Accepted --> Merged: re-verify, merge
    }
```

_Figure 1: the two lifecycles. Developing and Checking are the In review column, Agreed and Accepted
are Approved, Waiting and Building are In progress, Closed and Merged are Done. The owner makes the
moves marked "owner"; scripts make the rest._

### The assignee is whoever must act

This holds for issues and PRs, on the board or not.

- **Assigned to the owner:** they must read, playtest, answer or decide. Hand over a delivery or
  a developed issue with `review.sh <ref> owner`, and a question with `review.sh <ref> ask`. The
  comment must say what to look at, how to run it, and which decisions are theirs.
- **Assigned to you** (the login the scripts run as): act on it, even if all it needs is a reply.
  `board.sh mine` lists these. When you are done, take yourself off (`review.sh <ref> answer`,
  `board.sh turn <ref> nobody`) or hand it to the owner if you need them.
- **Nobody assigned:** a worker has it, or nothing is pending.
- After a review the owner takes themselves off or assigns you. Read their comment on the card,
  then act.

### Progress says what a card waits on

The Progress text field reads `<state>[ 🔁<round>][ 🔴]`: what the card is waiting on, which READY
round it is in, and whether CI is red on its head. Orchestrator scripts update it as a side effect;
never edit it by hand (`board_progress` in `scripts/lib/board.sh`). Merged and closed cards have no
value.

| State | Meaning                                    | Set by                                 |
| ----- | ------------------------------------------ | -------------------------------------- |
| ⛔    | Opened on hold                             | `open-task.sh --hold`                  |
| 🤖🔨  | Worker is building                         | open/release, review changes or answer |
| 🤖❓  | Worker asked a question                    | watcher                                |
| 🤖📐  | Worker posted a design note                | watcher                                |
| 🤖🚫  | Worker is blocked                          | watcher                                |
| 🤖👍  | Worker is ready; includes the review round | watcher                                |
| 🧭🔍  | Orchestrator verifies                      | `verify.sh`                            |
| 👤🔍  | Owner review                               | `review.sh owner`                      |
| 👤❓  | Owner was asked something                  | `review.sh ask`                        |
| 💥    | Branch conflicts with its base             | watcher                                |
| ⏳    | No commit or comment for 40+ minutes       | watcher                                |
| 🔑    | Worker waits for permission                | watcher                                |
| 🪫    | Worker turn failed                         | watcher                                |
| 💤    | Worker has not replied to a review         | watcher                                |

The watcher marks CI red on the PR head. A worker comment or new commit clears stuck states and
returns the card to working; a conflict clears when the branch merges cleanly again. Approval and
answers on issues clear the value. A merge or external close clears it entirely. Worker scripts do
not access the board; watcher updates are therefore eventual.

### Issues: develop, agree, then open the PR

- **Take the first card of Ready that nothing blocks** (`board.sh next`); don't wait to be told.
  Move it to In review and assign yourself while you work on it. A blocked card is not touched,
  whatever its place: it stays in Ready until its blockers close.
- **Develop it on the issue.** An issue may start as one vague line. Read the code, then write on
  the issue: questions, options with a recommendation, and finally the spec (what, why, the
  decisions, done-when, how it will be checked and whether the owner will be asked to playtest).
  Assign the owner each time you need them. A ticket that is already precise takes one round.
- **Gating:** bugs with a reproducer or a profile (a crash, wrong result, divergence, or measured
  hot-path cost) go straight to work (`open-task.sh --unapproved` when they have an issue).
  Everything else waits for Approved; an owner's "go" in chat is the approval for a direct PR.
- **Shortcut: a direct PR.** When something has been settled with the owner in chat and they say
  to go, open the task PR without an issue: `open-task.sh --direct "<title>" <task.md>`. Their
  word in chat is the approval. The task file must carry everything that was agreed, because no
  issue holds it. If it is not clear that they said go, ask in one line.
- **On Approved:** replace the issue's body with the agreed text (`open-task.sh --spec`; GitHub
  keeps the earlier versions in the edit history) and open the draft PR with the final prompt. The
  issue goes to In progress and stays on the board until its PRs close. One issue can have several
  PRs: the last says `Closes #n`, the others `Part of #n` (`--part`).
- **Dependencies are issue relations.** An issue that needs another one first is marked "blocked
  by" it: `board.sh block <issue> <blocker…>`, and `board.sh blocked <issue>` lists the open
  blockers. Set them when you open an issue, so the owner can see what can be launched.
- **New work, a follow-up, an idea:** `board.sh issue` opens an issue in Backlog for the owner to
  decide, with its relations. Issues that came from the first engineering plan carry the label
  `planned` and an epic label (`E5` to `E11`) and keep their plan names (`E6-T2 — …`); new issues
  don't get such names.

### PRs: build, check, merge

- **The PR holds the delivery's conversation:** the worker's rounds, your review, the evidence,
  the playtest steps and the owner's playtest feedback. When a playtest changes what was agreed,
  also correct the issue's body, so the issue stays true.
- **Every PR goes to the owner before it merges.** Assign it to the owner for review; no class of
  PR is merged without owner review.
- **Releases are cards of their own.** Record the PRs they carry, whether the wire changes, the
  stress and benchmark comparison, and whether consumers must deploy server and client together.
- **On Approved:** re-verify if `dev` moved, stop the worker, merge. The merge closes the issue
  and moves both cards to Done. `merge-task.sh` then prints what the merge made startable
  (`next: #n`, `launch: #n`): act on that line, because the watcher will not repeat it.

### Everything else

**Tracks keep other sessions' work apart.** Label an issue `track:<name>` to run it separately;
its PRs inherit the track through the same label or a `Closes #n` / `Part of #n` reference.
The main session never acts on track items. Start a track session with `VECS_TRACK=<name>` for
every orchestrator script and its own watcher; set `VECS_BASE=<branch>` when its task PRs should
target an integration branch instead of `dev`. Track sessions see only their own items and opened
PRs receive the track label. `board.sh tracks` lists track membership and `board.sh list` annotates
it. The watcher refreshes REST labels every 30 seconds and stores per-track state at
`vecs-watch-<track>`. `WATCH_ONLY` and `WATCH_SKIP` remain available.

- **Write on the card, not in the chat.** Results, conclusions, questions and next steps about one
  item go in a comment on its issue or PR; then move the card and set whose move it is. The chat
  with the owner is for coordination: priorities and order across issues, how the project is
  run, and problems that span several items. Don't report the status of single items there; the
  column and the assignee say it.
- **Every state change is a card move.** The scripts make the moves that belong to their step. Use
  `board.sh move` and `board.sh turn` for anything else, so no card sits in a stale column.
- **Watch the board while work is going on.** `watch-prs.sh` wakes you only for what needs you:
  a worker's READY, QUESTION, DESIGN or BLOCKED; a person's comment on any issue or PR; a card the owner moved to Approved or In review (`BOARD`); the first unblocked card of Ready changing (`NEXT`); an approved issue that nothing blocks, at once or when its last blocker closes (`LAUNCH`); something newly assigned to you (`ASSIGNED`); the owner taking themselves
  off a card (`OWNER DONE`); a worker that waits for a permission or whose turn failed (`WORKER`);
  a stale review. Everything else (other worker notes, cards moving to
  In progress, your own moves and merges) stays quiet and is listed with the next real
  event. It polls GitHub from the shell every 10 seconds without waking the orchestrator while
  nothing happens, but still spends API points. It slows its GraphQL polls as the
  budget runs low (`BUDGET` says when only the reserve remains). Run it with `ONESHOT=1` and start it again after each event. If it ends on its own
  (`MAX_MINUTES`, or the runner's limit) because nothing happened for two hours, don't start it
  again: the owner is away and will say when work resumes.
- **The GraphQL budget is shared.** GitHub gives the account 5,000 GraphQL points an hour for
  everything it does, and the board can only be read with GraphQL. A typical watcher poll costs
  two points (task PRs and one page of non-Done cards), about 720 an hour at 10 seconds. It keeps
  `BUDGET_RESERVE` (default 500) for scripts run by hand and spreads the rest over the time to the
  reset, never faster than `INTERVAL` (default 10 seconds). With no spendable points it emits one
  `BUDGET` event per reset window and keeps watching REST comments and assignments only until
  the reset. Read `X-RateLimit-Remaining` and `X-RateLimit-Reset` from GraphQL response headers
  (`gh api graphql -i …`), not `gh api rate_limit` or the query's `rateLimit` field: both lag.
  The watcher remembers counters by reset time and uses the lowest remaining budget.
- **Never poll the board in a shell loop**, or retry a failed board call in a loop. A card just
  added can be missing from the listing for minutes although its issue already shows it: read
  it from the issue (`gh issue view <n> --json projectItems`) instead of waiting for it.
- **Done is kept short.** It shows the six most recently closed cards across both repositories.
  `merge-task.sh` runs `board.sh archive [keep]` after every merge (default 6), archiving only
  `vworlds/vecs` cards ranked after those six; an archive failure does not fail the merge. Archived cards stay in the
  project's "Archived items" view and can be restored. The watcher and default `list`, `next`
  and `mine` omit Done; use `board.sh list --all` or `board.sh list Done` to see it.
- **Keep the watcher smart.** When it wakes you for something that needed no action, or for
  something it could have done itself, change the script so it doesn't happen again.
- `VECS_BOARD=off` turns the board steps off, for forks and offline work.

## Workers

A worker is an opencode session that works in a task PR's worktree. `worker.sh` talks to the
opencode 2 HTTP server with the login in the environment (`OPENCODE_BASE_URL`,
`OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`); `worker.sh health` says whether it
answers, and `worker.sh models [filter]` lists its models. The default model is `WORKER_MODEL`
or `codexbal/gpt-6.1-sol`. Session mappings live in
`${XDG_STATE_HOME:-~/.local/state}/vecs-orchestrator/workers`.

1. After `open-task.sh`, create the worktree:
   `git worktree add -b <branch> .worktrees/auto-<branch> origin/<branch>`.
2. `worker.sh start <worktree> <prompt.md> --title "PR <n> work" [--model provider/id]`. The prompt
   says which PR to read as the task; the task itself is the PR's description. It returns at once
   and prints the session id; from then on the worktree's path names the session too.
3. Look at `worker.sh status <worktree>` a minute later: a worker that waits for a permission says
   so there. `worker.sh permit <worktree>` lists requests; add `once`, `always` or `reject` to answer.
4. A review round: post the `[orchestrator]` comment with `review.sh`, then
   `worker.sh send <worktree> <prompt.md>` telling it to read that comment. It resumes an idle
   worker and steers a running one; `--queue` waits until the current turn finishes.
   Use `worker.sh send --now <worktree> <prompt.md>` when a long tool call prevents it from
   reading steering: it interrupts the turn, waits up to 30 seconds for idle, then sends. If the
   wait fails or the worker stays busy, it reports failure without sending. Do not combine it
   with `--queue`.
5. `worker.sh log <worktree> [n]` shows its last steps. `worker.sh wait <worktree> [seconds]`
   waits for an idle session (default 600 seconds), exiting 1 if still running.
6. `worker.sh stop <worktree>` before merging; remove the worktree after the merge.

If a worker stops on a quota error (codexbal 502 / temporarily disabled subscriptions, or
ollama-cloud 429 / Pro 5-hour limit), use `worker.sh model <session|dir> <provider/id>`, then send
"continue where you left off". Keep the same session and its context; never start a replacement
session in that worktree. Follow the owner's model order: `codexbal/gpt-6.1-sol`, then
`ollama-cloud/glm-5.3` (no vision), then `opencode/big-pickle`. The model command validates the
`provider/id` form and reports the HTTP status if the server refuses the switch.

## Review and merge

1. Read the READY report and the diff. Verify the behavior independently: run the code, and use
   your own oracle for any invariant the worker claims. Check per-tick cost against
   `lib/vecs/docs/design-guide.md`; require benchmark evidence for hot-path changes.
   Workers report CI with `scripts/agent/wait-checks.sh <pr>`'s exit code and last line:
   green (0), red with a failure digest (1), or no verdict (2). No verdict means
   `[worker] BLOCKED: checks gave no verdict`, not a code failure.
2. `verify.sh <pr>` (with every other PR that will land alongside it).
3. Post the outcome with `review.sh`: `[orchestrator] CHANGES REQUESTED (round N)` (`changes`),
   `[orchestrator] OWNER REVIEW` for gameplay the owner must playtest or anything else they must
   decide (`owner`: the card stays In review, assigned to the owner), or `[orchestrator] APPROVED` (`approve`).
4. **Stop the worker before merging**, so it doesn't spend tokens reacting to the merge:
   `worker.sh stop <worktree>`.
5. `merge-task.sh <pr>`.

### Merging a pack

Merge an approved integration-pack PR with `merge-task.sh <pr> --merge-commit`. This uses a merge
commit so the pack branch's integration history is preserved. The `pack/*` head branch is kept by
default; pass `--delete-branch` only when the owner wants it removed.
