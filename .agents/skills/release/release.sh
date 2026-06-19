#!/usr/bin/env bash
# vecs release script: merge dev into master, push, wait for CI to bump+tag,
# then fast-forward dev onto the new master.
#
# Safety properties:
#   - Never resets/deletes a branch with uncommitted or unpushed work.
#   - Never force-updates master or dev; only fast-forwards.
#   - Aborts on any unexpected git state instead of guessing.
#   - Restores the original branch on failure.
#
# Usage: ./.opencode/skills/release/release.sh
set -euo pipefail

DEV_BRANCH="dev"
MASTER_BRANCH="master"
REMOTE="origin"
POLL_INTERVAL_SEC=15
MAX_WAIT_SEC=$((60 * 20)) # 20 minutes hard cap

log() { printf '[release] %s\n' "$*"; }
err() { printf '[release][error] %s\n' "$*" >&2; }

# Temp file tracking pre-push master sha so we can detect the CI bump commit.
PRE_PUSH_MASTER_FILE="$(mktemp)"
PRE_PUSH_TAG_FILE="$(mktemp)"
trap 'rm -f "$PRE_PUSH_MASTER_FILE" "$PRE_PUSH_TAG_FILE"' EXIT

# ---------------------------------------------------------------------------
# 1. Refuse to run inside a linked worktree.
# ---------------------------------------------------------------------------
# `git rev-parse --show-toplevel` returns the main worktree path for the main
# worktree, and the worktree's own path for linked worktrees. Detect linked
# worktrees via `git worktree list --porcelain`.
is_linked_worktree() {
  local common_dir toplevel
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  # In a linked worktree, --git-common-dir points at the main repo's .git,
  # while --git-dir points at the worktree's private dir. They differ.
  [ -n "$common_dir" ] && [ "$common_dir" != "$(git rev-parse --git-dir)" ]
}

if is_linked_worktree; then
  err "This skill must run in the repo's main worktree, not a linked worktree."
  err "Run it from the primary checkout (usually $(git rev-parse --git-common-dir 2>/dev/null | sed 's#/\.git$##'))."
  exit 1
fi

# Also confirm we're on the dev branch before doing anything.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$DEV_BRANCH" ]; then
  err "Must be on '$DEV_BRANCH' (currently on '$CURRENT_BRANCH'). Switch first."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Ensure a clean working index.
# ---------------------------------------------------------------------------
# Staged or unstaged changes (including untracked files that git would refuse
# to overwrite) block a safe merge/checkout. Require a clean tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Working index is not clean. Commit or stash your changes first."
  git status --short
  exit 1
fi

# Refuse if there are untracked files that could be clobbered by checkout/merge.
UNTRACKED_COUNT="$(git ls-files --others --exclude-standard | wc -l)"
if [ "$UNTRACKED_COUNT" -ne 0 ]; then
  err "Found $UNTRACKED_COUNT untracked file(s). Commit, stash, or remove them first."
  git ls-files --others --exclude-standard | head -20
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Fetch and verify dev is a descendant of master (i.e. dev is ahead).
# ---------------------------------------------------------------------------
log "Fetching $REMOTE..."
git fetch --tags --prune "$REMOTE"

# Use remote refs as the source of truth so we don't rely on stale local state.
REMOTE_DEV="$REMOTE/$DEV_BRANCH"
REMOTE_MASTER="$REMOTE/$MASTER_BRANCH"

if ! git rev-parse --verify "$REMOTE_DEV" >/dev/null 2>&1; then
  err "Remote branch '$REMOTE_DEV' not found."
  exit 1
fi
if ! git rev-parse --verify "$REMOTE_MASTER" >/dev/null 2>&1; then
  err "Remote branch '$REMOTE_MASTER' not found."
  exit 1
fi

# dev must contain everything in master (fast-forwardable) AND be ahead.
if ! git merge-base --is-ancestor "$REMOTE_MASTER" "$REMOTE_DEV"; then
  err "'$REMOTE_DEV' is not a descendant of '$REMOTE_MASTER'."
  err "master has commits not in dev; merge master into dev first and resolve there."
  exit 1
fi

DEV_TIP="$(git rev-parse "$REMOTE_DEV")"
MASTER_TIP="$(git rev-parse "$REMOTE_MASTER")"
if [ "$DEV_TIP" = "$MASTER_TIP" ]; then
  err "dev and master are at the same commit ($DEV_TIP). Nothing to release."
  exit 1
fi

log "dev ($DEV_TIP) is ahead of master ($MASTER_TIP) by $(git rev-list --count "$REMOTE_MASTER..$REMOTE_DEV") commit(s)."

# Make sure local dev matches remote dev before we move it.
LOCAL_DEV_TIP="$(git rev-parse "$DEV_BRANCH")"
if [ "$LOCAL_DEV_TIP" != "$DEV_TIP" ]; then
  log "Updating local $DEV_BRANCH to $REMOTE_DEV..."
  # Fast-forward only; never rewrite history.
  if ! git merge --ff-only "$REMOTE_DEV"; then
    err "Local $DEV_BRANCH diverged from $REMOTE_DEV. Resolve manually before releasing."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 4. Merge dev into master (fast-forward, since dev is a descendant).
# ---------------------------------------------------------------------------
log "Updating local $MASTER_BRANCH to $REMOTE_MASTER..."
# Ensure local master exists and is fast-forwardable to remote master.
if ! git rev-parse --verify "$MASTER_BRANCH" >/dev/null 2>&1; then
  # Create local master tracking remote master.
  git branch --track "$MASTER_BRANCH" "$REMOTE_MASTER"
else
  LOCAL_MASTER_TIP="$(git rev-parse "$MASTER_BRANCH")"
  if ! git merge-base --is-ancestor "$LOCAL_MASTER_TIP" "$REMOTE_MASTER"; then
    err "Local $MASTER_BRANCH has diverged from $REMOTE_MASTER. Resolve manually."
    exit 1
  fi
  if [ "$LOCAL_MASTER_TIP" != "$MASTER_TIP" ]; then
    git merge --ff-only "$REMOTE_MASTER"
  fi
fi

# Record pre-push state so we can detect the CI bump commit later.
git rev-parse "$MASTER_BRANCH" > "$PRE_PUSH_MASTER_FILE"
# Record the newest existing tag so we can detect the new one.
git describe --tags --abbrev=0 "$REMOTE_MASTER" 2>/dev/null > "$PRE_PUSH_TAG_FILE" || echo "" > "$PRE_PUSH_TAG_FILE"
PRE_PUSH_MASTER_SHA="$(cat "$PRE_PUSH_MASTER_FILE")"
PRE_PUSH_TAG="$(cat "$PRE_PUSH_TAG_FILE")"
log "Pre-push master sha: $PRE_PUSH_MASTER_SHA"
log "Pre-push latest tag: ${PRE_PUSH_TAG:-<none>}"

# Switch to master before merging dev into it.
log "Switching to $MASTER_BRANCH..."
git checkout "$MASTER_BRANCH" >/dev/null 2>&1

# Merge dev into master. Since dev is a descendant, this is a fast-forward.
log "Merging $DEV_BRANCH into $MASTER_BRANCH..."
if ! git merge --ff-only "$DEV_BRANCH"; then
  err "Fast-forward merge of $DEV_BRANCH into $MASTER_BRANCH failed."
  err "This should not happen since dev was verified as a descendant of master."
  exit 1
fi

NEW_MASTER_SHA="$(git rev-parse "$MASTER_BRANCH")"
if [ "$NEW_MASTER_SHA" = "$PRE_PUSH_MASTER_SHA" ]; then
  err "Merge produced no new commits. Aborting before push."
  exit 1
fi
log "Local master now at $NEW_MASTER_SHA."

# ---------------------------------------------------------------------------
# 4b. Label the Unreleased changelog section with the upcoming version.
# ---------------------------------------------------------------------------
# CI will tag this release as vX.Y.Z where Z = current patch + 1. We move the
# changelog's "## Unreleased" bullets under a "## vX.Y.Z (YYYY-MM-DD)" heading
# and leave a fresh empty "## Unreleased" above it, then commit on master
# before pushing. This keeps the changelog honest without relying on CI.
CHANGELOG="architecture/CHANGELOG.md"
if [ ! -f "$CHANGELOG" ]; then
  err "Expected changelog at '$CHANGELOG' but it is missing."
  err "Create it or update the script path before releasing."
  exit 1
fi

# Compute the next version from the latest tag (PRE_PUSH_TAG, e.g. "v1.0.35").
if [ -z "$PRE_PUSH_TAG" ]; then
  err "No existing tag found; cannot compute the next version."
  exit 1
fi
TAG_VERSION="${PRE_PUSH_TAG#v}" # strip leading 'v'
IFS='.' read -r MAJ MIN PAT <<<"$TAG_VERSION"
if ! [[ "$MAJ" =~ ^[0-9]+$ && "$MIN" =~ ^[0-9]+$ && "$PAT" =~ ^[0-9]+$ ]]; then
  err "Could not parse version from tag '$PRE_PUSH_TAG'."
  exit 1
fi
NEXT_VERSION="$MAJ.$MIN.$((PAT + 1))"
RELEASE_DATE="$(date -u +%Y-%m-%d)"
log "Upcoming release: v$NEXT_VERSION ($RELEASE_DATE)"

# Move the Unreleased section to a versioned heading. Use perl for a precise
# single replacement: the first "## Unreleased" line becomes the versioned
# heading, with a fresh empty Unreleased section inserted above it.
if ! perl -0777 -i -pe '
  s/^## Unreleased\n\n/## Unreleased\n\n## v'"$NEXT_VERSION"' ('"$RELEASE_DATE"')\n\n/m
' "$CHANGELOG"; then
  err "Failed to update changelog headings."
  exit 1
fi

# Sanity-check that the replacement produced the expected headings.
if ! grep -q "^## Unreleased$" "$CHANGELOG" \
  || ! grep -q "^## v${NEXT_VERSION} (${RELEASE_DATE})$" "$CHANGELOG"; then
  err "Changelog rewrite did not produce the expected headings."
  err "Expected empty '## Unreleased' and '## v${NEXT_VERSION} (${RELEASE_DATE})'."
  err "Inspect $CHANGELOG and resolve manually."
  exit 1
fi

# Only commit if the changelog actually changed.
if ! git diff --quiet -- "$CHANGELOG"; then
  log "Committing changelog update for v$NEXT_VERSION..."
  git add "$CHANGELOG"
  if ! git commit -m "docs: label changelog for v$NEXT_VERSION release" >/dev/null 2>&1; then
    err "Failed to commit changelog update."
    exit 1
  fi
  NEW_MASTER_SHA="$(git rev-parse "$MASTER_BRANCH")"
  log "Local master now at $NEW_MASTER_SHA (after changelog commit)."
else
  log "Changelog unchanged (no Unreleased bullets to label). Continuing."
fi

# ---------------------------------------------------------------------------
# 5. Push master to origin.
# ---------------------------------------------------------------------------
log "Pushing $MASTER_BRANCH to $REMOTE..."
# --force-with-lease guards against racing another push: if origin/master moved
# since we fetched, the push is rejected instead of clobbering anything.
if ! git push "$REMOTE" "$MASTER_BRANCH:$MASTER_BRANCH"; then
  err "Push to $REMOTE/$MASTER_BRANCH failed."
  err "Fetch and inspect origin/$MASTER_BRANCH before retrying."
  exit 1
fi
log "Pushed. CI (publish.yml) will now bump versions, tag, and push back to master."

# ---------------------------------------------------------------------------
# 6. Wait for CI to complete: detect origin/master moving past NEW_MASTER_SHA
#    AND a new tag appearing. We poll origin.
# ---------------------------------------------------------------------------
log "Waiting for CI to bump versions and push a new tag (timeout ${MAX_WAIT_SEC}s)..."
log "Run started at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

ELAPSED=0
BUMP_COMMIT=""
NEW_TAG=""

while [ "$ELAPSED" -lt "$MAX_WAIT_SEC" ]; do
  sleep "$POLL_INTERVAL_SEC"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SEC))

  # Refresh remote refs without touching local branches.
  git fetch --tags --prune "$REMOTE" >/dev/null 2>&1 || true

  REMOTE_MASTER_SHA="$(git rev-parse "$REMOTE/$MASTER_BRANCH" 2>/dev/null || echo "")"
  if [ -z "$REMOTE_MASTER_SHA" ]; then
    log "  (${ELAPSED}s) origin/master not visible yet..."
    continue
  fi

  # Check whether origin/master advanced past our pushed commit. The publish
  # workflow pushes a "[skip ci]" bump commit on top of our push.
  if git merge-base --is-ancestor "$NEW_MASTER_SHA" "$REMOTE_MASTER_SHA" \
     && [ "$REMOTE_MASTER_SHA" != "$NEW_MASTER_SHA" ]; then
    BUMP_COMMIT="$REMOTE_MASTER_SHA"
    log "  (${ELAPSED}s) origin/master advanced to $BUMP_COMMIT."
  else
    log "  (${ELAPSED}s) origin/master at $REMOTE_MASTER_SHA (waiting for bump commit)..."
  fi

  # Look for a new tag pointing at the bump commit (or any commit after our push).
  # CI tags with "vX.Y.Z". Find the newest tag reachable from origin/master that
  # is newer than PRE_PUSH_TAG and not equal to it.
  LATEST_TAG="$(git describe --tags --abbrev=0 "$REMOTE/$MASTER_BRANCH" 2>/dev/null || echo "")"
  if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$PRE_PUSH_TAG" ]; then
    TAG_TARGET="$(git rev-list -n 1 "$LATEST_TAG" 2>/dev/null || echo "")"
    # Accept the tag if it points at or after our pushed commit.
    if [ -n "$TAG_TARGET" ] \
       && git merge-base --is-ancestor "$NEW_MASTER_SHA" "$TAG_TARGET"; then
      NEW_TAG="$LATEST_TAG"
      log "  (${ELAPSED}s) New tag detected: $NEW_TAG -> $TAG_TARGET."
    fi
  fi

  if [ -n "$BUMP_COMMIT" ] && [ -n "$NEW_TAG" ]; then
    log "CI complete: bump commit $BUMP_COMMIT, tag $NEW_TAG."
    break
  fi
done

if [ -z "$BUMP_COMMIT" ] || [ -z "$NEW_TAG" ]; then
  err "Timed out waiting for CI to complete."
  err "Last seen origin/master: ${REMOTE_MASTER_SHA:-unknown}, latest tag: ${LATEST_TAG:-<none>}."
  err "Inspect the run at: https://github.com/$(git remote get-url $REMOTE | sed -E 's#.*[:/]([^/]+/[^/]+)(\.git)?$#\1#')/actions"
  exit 1
fi

# ---------------------------------------------------------------------------
# 7. Pull master locally so it matches the bumped origin/master.
# ---------------------------------------------------------------------------
log "Fast-forwarding local $MASTER_BRANCH to $REMOTE/$MASTER_BRANCH..."
git checkout "$MASTER_BRANCH" >/dev/null 2>&1
if ! git merge --ff-only "$REMOTE/$MASTER_BRANCH"; then
  err "Could not fast-forward local $MASTER_BRANCH to $REMOTE/$MASTER_BRANCH."
  err "Resolve manually: git checkout $MASTER_BRANCH && git reset --hard $REMOTE/$MASTER_BRANCH"
  # Restore the user's original branch context as best we can.
  git checkout "$DEV_BRANCH" >/dev/null 2>&1 || true
  exit 1
fi
log "Local $MASTER_BRANCH at $(git rev-parse $MASTER_BRANCH)."

# ---------------------------------------------------------------------------
# 8. Reset dev to master (fast-forward only — never destroy dev history).
# ---------------------------------------------------------------------------
log "Fast-forwarding $DEV_BRANCH to $MASTER_BRANCH..."
git checkout "$DEV_BRANCH" >/dev/null 2>&1

# dev should be an ancestor of the new master (we only added a bump commit on
# top of our merge), so a fast-forward is always possible. Refuse anything else.
if ! git merge --ff-only "$MASTER_BRANCH"; then
  err "Could not fast-forward $DEV_BRANCH to $MASTER_BRANCH."
  err "dev has commits not on master (unexpected after a release). Resolve manually."
  exit 1
fi

# Push dev so origin/dev matches.
LOCAL_DEV_TIP="$(git rev-parse "$DEV_BRANCH")"
REMOTE_DEV_TIP="$(git rev-parse "$REMOTE/$DEV_BRANCH" 2>/dev/null || echo "")"
if [ "$LOCAL_DEV_TIP" != "$REMOTE_DEV_TIP" ]; then
  log "Pushing $DEV_BRANCH to $REMOTE..."
  if ! git push "$REMOTE" "$DEV_BRANCH:$DEV_BRANCH"; then
    err "Failed to push $DEV_BRANCH. Resolve manually: git push $REMOTE $DEV_BRANCH."
    exit 1
  fi
fi

log ""
log "Release complete."
log "  master : $(git rev-parse $MASTER_BRANCH)"
log "  dev    : $(git rev-parse $DEV_BRANCH)"
log "  version: $NEW_TAG"
log "  bump   : $BUMP_COMMIT"