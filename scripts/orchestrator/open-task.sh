#!/usr/bin/env bash
# Open a task PR for an approved issue: a placeholder branch off origin/dev plus a draft PR whose
# body is a short header pointing at .agents/workflows/task-workflow.md, "Closes #<issue>", and the task
# file (the final prompt). Idempotent: if the branch or PR already exists, it reuses or reports it.
# Usage: scripts/orchestrator/open-task.sh <issue> <task.md> [--spec spec.md] [--part] [--slug words]
#                                          [--title text] [--hold] [--unapproved]
#        scripts/orchestrator/open-task.sh --direct "<title>" <task.md> [--slug words] [--hold]
#   --direct the shortcut for something settled with the owner in chat: a task PR with no issue.
#            The owner's word in chat is the approval, and the task file must carry everything
#            that was agreed, because no issue holds it.
#   issue    the issue this task resolves: its number (216, #216), or the plan name of an issue
#            that has one (E6-T2). Every task has an issue; open one with board.sh issue.
#   --spec   the text agreed in the issue's conversation: it replaces the issue's body (GitHub
#            keeps the earlier versions in the edit history)
#   --part   this PR is not the issue's last one: it says "Part of #n" and its merge leaves the
#            issue open
#   --title  PR title; defaults to the issue's title
#   --hold   mark the PR on hold for owner review: no agent may start it until release-hold.sh
#   --unapproved   open it although the issue's card is not in Approved (say why on the issue)
# Refused: an issue that another open issue blocks ("blocked by" relation), and an issue the owner
# has not approved (its card must be in Approved): no PR exists before the owner agrees to what
# the issue says.
# Board: the issue's card goes to In progress and waits there until its PRs close; the PR's card
# sits below it, in In progress, or with --hold in In review assigned to the owner.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
cd "$(git rev-parse --show-toplevel)"
usage="usage: open-task.sh <issue> <task.md> [--spec f] [--part] [--slug s] [--title t] [--hold] [--unapproved] | open-task.sh --direct <title> <task.md> [--slug s] [--hold]"
slug="" title="" spec="" hold=false part=false approved_only=true direct=false ref=""
if [ "${1:-}" = --direct ]; then
  direct=true
  title="${2:?$usage}"
  task="${3:?task file required}"
  shift 3
else
  ref="${1:?$usage}"
  task="${2:?task file required}"
  shift 2
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)
      slug="$2"
      shift 2
      ;;
    --title)
      title="$2"
      shift 2
      ;;
    --spec)
      spec="$2"
      shift 2
      ;;
    --part)
      part=true
      shift
      ;;
    --unapproved)
      approved_only=false
      shift
      ;;
    --hold)
      hold=true
      shift
      ;;
    *) die "unknown option $1" ;;
  esac
done
[ -r "$task" ] || die "cannot read $task"
[ -z "$spec" ] || [ -r "$spec" ] || die "cannot read $spec"
if $direct; then
  [ -z "$spec" ] && ! $part || die "--spec and --part need an issue"
  issue=""
fi

if $direct; then
  :
elif [[ "${ref#\#}" =~ ^[0-9]+$ ]]; then
  issue="${ref#\#}"
elif [[ "$ref" =~ ^E[0-9]+-T[0-9]+[a-z]?$ ]]; then
  # Issues that came from the old plan keep its names. The name is [A-Za-z0-9-] only, so it is
  # safe to inline into the jq program.
  issue="$(retry 3 gh api --paginate "repos/$REPO_SLUG/issues?state=open&per_page=100" \
    | jq -r "[.[] | select(.pull_request | not) | select(.title | test(\"^$ref( |\$)\"; \"i\"))][0].number // empty")"
  [ -n "$issue" ] || die "no open issue named $ref"
else
  die "cannot read '$ref' as an issue number or a plan name"
fi
if ! $direct; then
  info="$(retry 3 gh api "repos/$REPO_SLUG/issues/$issue" --jq '[.state, (has("pull_request") | tostring), .title] | @tsv')" \
    || die "cannot read issue #$issue"
  IFS=$'\t' read -r state is_pr issue_title <<< "$info"
  [ "$is_pr" = false ] || die "#$issue is a pull request, not an issue"
  [ "$state" = open ] || die "issue #$issue is $state"
  # A blocked issue is not started: it waits in Ready until its blockers close.
  blockers="$(board_blockers "$issue" | cut -f1 | sed 's/^/#/' | paste -sd' ' -)" || die "cannot read the blockers of #$issue"
  [ -z "$blockers" ] || die "issue #$issue is blocked by $blockers"
  [ -n "$title" ] || title="$issue_title"
fi

# Branches lead with their PR number (`207-e5-t4-magnetic-snap-stack`), so branch and worktree
# names match the PR; a plan name in the title stays in the branch. Older task branches are
# `task-<ticket>-<slug>`.
[ -n "$slug" ] || slug="$(printf '%s' "$title" | tr 'A-Z' 'a-z' | sed -E 's/^e[0-9]+-t[0-9]+[a-z]? *—? *//; s/[^a-z0-9]+/-/g; s/^-|-$//g' | cut -d- -f1-5)"
name="$(printf '%s' "$title" | grep -o -E '^E[0-9]+-T[0-9]+[a-z]?' | tr 'A-Z' 'a-z' || true)"
suffix="${name:+$name-}$slug"
pr_title="$title (agent task)"
$hold && pr_title="[HOLD: owner review] $pr_title"

# The suffix is [a-z0-9-] only, so it is safe to inline into the jq program.
existing="$(retry 3 gh pr list -R "$REPO_SLUG" --state all --limit 200 --json number,state,headRefName \
  --jq "[.[] | select(.headRefName == \"task-$suffix\" or (.headRefName | test(\"^[0-9]+-$suffix\$\")))][0] | select(.) | \"\\(.number) \\(.state)\"")"
if [ -n "$existing" ]; then
  log "PR already exists: #${existing% *} (${existing#* }) for $suffix"
  echo "${existing% *}"
  exit 0
fi
# The owner approves an issue before any PR is opened for it.
if ! $direct && $approved_only && board_enabled; then
  column="$(board_where "$issue")" || die "cannot read the board"
  [ "$column" = Approved ] || die "issue #$issue is in ${column:-no column}, not Approved (--unapproved overrides)"
fi
if [ -n "$spec" ]; then
  retry 3 gh api -X PATCH "repos/$REPO_SLUG/issues/$issue" -F body=@"$spec" > /dev/null || die "could not update the body of #$issue"
  log "issue #$issue now carries the agreed text"
fi
# Issues and PRs share one number sequence. The number is predicted and checked after creation.
# The REST list lags for a few seconds after a PR is created (two tasks opened back to back got
# the same prediction), so take the highest of it and the GraphQL view.
latest="$({
  retry 3 gh api "repos/$REPO_SLUG/issues?state=all&per_page=1&sort=created&direction=desc" --jq '.[0].number // 0'
  retry 3 gh api graphql -f owner="${REPO_SLUG%/*}" -f name="${REPO_SLUG#*/}" -f query='
    query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      issues(last: 1) { nodes { number } } pullRequests(last: 1) { nodes { number } } } }' \
    --jq '.data.repository | (.issues.nodes[0].number // 0), (.pullRequests.nodes[0].number // 0)'
} | sort -n | tail -1)"
branch="$((latest + 1))-$suffix"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
  if $hold; then
    printf '> ⛔ **ON HOLD for owner review. Do not start.** No agent may pick this up until the orchestrator posts `[orchestrator] GO`.\n\n'
  fi
  printf '> **Agent task%s.** Branch `%s`, base `dev`. Follow [`.agents/workflows/task-workflow.md`](https://github.com/%s/blob/dev/.agents/workflows/task-workflow.md): this description is your prompt, and `[orchestrator]` comments amend it.\n\n' "${issue:+ for #$issue}" "$branch" "$REPO_SLUG"
  if $direct; then
    printf 'Agreed with the owner in chat; this task has no issue.\n\n'
  elif $part; then
    printf 'Part of #%s.\n\n' "$issue"
  else
    printf 'Closes #%s.\n\n' "$issue"
  fi
  cat "$task"
} > "$body"

fetch_refs "+dev:refs/remotes/origin/dev" || die "fetch failed"
if ! git ls-remote --exit-code --heads "https://github.com/$REPO_SLUG.git" "$branch" > /dev/null 2>&1; then
  commit="$(git commit-tree "origin/dev^{tree}" -p origin/dev -m "chore: open task${issue:+ for #$issue} ($branch)")"
  push_ref "$commit:refs/heads/$branch" || die "could not push $branch"
fi
url="$(retry 3 gh pr create -R "$REPO_SLUG" --draft --base dev --head "$branch" --title "$pr_title" --body-file "$body")" || die "gh pr create failed"
log "opened $url"
[ "${url##*/}" = "${branch%%-*}" ] || log "warning: PR #${url##*/} does not match branch $branch (another issue or PR was created meanwhile)"
if $hold; then
  board_move "${url##*/}" "In review" || true
  board_turn "${url##*/}" owner || true
else
  board_move "${url##*/}" "In progress" || true
fi
if ! $direct; then
  board_move "$issue" "In progress" || true
  board_turn "$issue" nobody || true
  board_beside "${url##*/}" "$issue" || true
fi
echo "${url##*/}"
