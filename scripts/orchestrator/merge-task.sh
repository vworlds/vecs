#!/usr/bin/env bash
# Merge an approved task PR, mechanically and idempotently:
#   1. mark the PR ready and merge exactly its head, retrying transient GitHub errors;
#   2. close the issues the PR says it closes, if GitHub hasn't already;
#   3. delete the branch, and fast-forward the main checkout if it is clean and on dev;
#   4. move the PR's card to Done on the board.
# Re-running after a partial failure continues where it stopped. Stop the PR's worker BEFORE
# running this.
# Usage: scripts/orchestrator/merge-task.sh <pr> [--merge-commit] [--delete-branch] [--subject text] [--body-file f]
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
pr="${1:?usage: merge-task.sh <pr> [--subject s] [--body-file f]}"
board_require_ours "$pr"
shift
subject="" body_file="" merge_commit=false delete_branch=false
while [ $# -gt 0 ]; do
  case "$1" in
    --merge-commit)
      merge_commit=true
      shift
      ;;
    --delete-branch)
      delete_branch=true
      shift
      ;;
    --subject)
      subject="$2"
      shift 2
      ;;
    --body-file)
      body_file="$2"
      shift 2
      ;;
    *) die "unknown option $1" ;;
  esac
done
main="$(git rev-parse --path-format=absolute --git-common-dir | sed 's|/.git$||')"
cd "$main"

info="$(retry 3 gh pr view "$pr" -R "$REPO_SLUG" --json state,title,headRefName,isDraft,mergeable,baseRefName --jq '[.state,.headRefName,.isDraft,.mergeable,.title,.baseRefName] | @tsv')"
IFS=$'\t' read -r state branch draft mergeable title base <<< "$info"
[ "$state" = CLOSED ] && die "PR #$pr is closed without merging"
# Read before merging: the list is what the PR body links with "Closes #n".
closes="$(retry 3 gh api graphql -f owner="${REPO_SLUG%/*}" -f name="${REPO_SLUG#*/}" -F pr="$pr" -f query='
  query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) { closingIssuesReferences(first: 20) { nodes { number } } } } }' \
  --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[].number' || true)"

if [ "$state" = OPEN ]; then
  [ "$mergeable" = CONFLICTING ] && die "PR #$pr conflicts with $base; ask the worker to merge origin/$base"
  fetch_refs "+$base:refs/remotes/origin/$base" "+refs/heads/$branch:refs/remotes/origin/$branch" || die "fetch failed"
  head="$(git rev-parse "origin/$branch")"
  [ "$draft" = true ] && retry 3 gh pr ready "$pr" -R "$REPO_SLUG" > /dev/null
  [ -n "$subject" ] || subject="$(printf '%s' "$title" | sed -E 's/^\[HOLD[^]]*\] //; s/ \(agent task\)$//') (#$pr)"
  bf="$(mktemp)"
  if [ -n "$body_file" ]; then
    cp "$body_file" "$bf"
  else
    printf 'See #%s for the review.%s\n' "$pr" "$(for n in $closes; do printf ' Closes #%s.' "$n"; done)" > "$bf"
  fi
  "$(dirname "$0")/../agent/check-markdown.sh" "$bf"
  # Tell the watcher this merge is ours, so it doesn't report the PR leaving the open list.
  mkdir -p "${BOARD_STATE%/board}" && touch "${BOARD_STATE%/board}/merged-$pr"
  merged=false
  board_hold_startable
  for attempt in 1 2 3 4; do
    strategy=--squash
    $merge_commit && strategy=--merge
    if gh pr merge "$pr" -R "$REPO_SLUG" "$strategy" --match-head-commit "$head" --subject "$subject" --body-file "$bf"; then
      merged=true
      break
    fi
    [ "$(pr_field "$pr" .state)" = MERGED ] && {
      merged=true
      break
    }
    log "merge attempt $attempt failed; retrying"
    sleep $((attempt * 5))
  done
  rm -f "$bf"
  $merged || die "could not merge #$pr"
fi

sha="$(retry 3 gh api "repos/$REPO_SLUG/pulls/$pr" --jq .merge_commit_sha)"
if [ "$base" = dev ]; then
  for n in $closes; do
    if [ "$(retry 3 gh api "repos/$REPO_SLUG/issues/$n" --jq .state)" = open ]; then
      retry 3 gh api -X PATCH "repos/$REPO_SLUG/issues/$n" -f state=closed -f state_reason=completed > /dev/null \
        && log "closed issue #$n"
    fi
    board_move "$n" "Done" || true
    board_turn "$n" nobody || true
    board_progress_clear "$n" || true
  done
fi
fetch_refs "+$base:refs/remotes/origin/$base" || die "fetch failed"
if $merge_commit && [[ "$branch" == pack/* ]] && ! $delete_branch; then
  log "kept integration branch $branch"
else
  gh api -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" > /dev/null 2>&1 && log "deleted branch $branch" || true
fi
git update-ref -d "refs/remotes/origin/$branch" 2> /dev/null || true
if [ "$base" = dev ] && [ "$(git rev-parse --abbrev-ref HEAD)" = dev ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  old_head="$(git rev-parse HEAD)"
  git merge -q --ff-only origin/dev
  new_head="$(git rev-parse HEAD)"
  log "main checkout fast-forwarded to ${new_head:0:7}"
  "$(dirname "$0")/install-deps-after-fast-forward.sh" "$main" "$old_head" "$new_head"
else
  log "main checkout left alone (PR base is $base)"
fi
board_move "$pr" "Done" || true
board_turn "$pr" nobody || true
board_progress_clear "$pr" || true
log "#$pr merged as ${sha:0:8}"
board_announce_startable || true
board_release_startable
# Done only grows: keep the six most recently closed cards, put away the rest.
board_archive_done 6 || true
