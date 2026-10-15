---
name: release
description: Cut a vecs release by merging dev into master, pushing, and waiting for CI to bump the version and tag.
---

# Release

Cut a vecs release. This merges `dev` into `master`, pushes `master`, waits for
the `Publish to npm` GitHub Actions workflow to bump versions and tag, then
fast-forwards `dev` onto the new `master`, then waits for publication and npm
registry propagation.

## When to use

Use when asked to "release", "cut a release", "ship to master", "bump the
version", or "publish a new vecs version".

## Mechanism

All git work is performed by `.agents/skills/release/release.sh`. Run it from
the repo root:

```bash
./.agents/skills/release/release.sh
```

The script is the source of truth for the release flow. It is idempotent for
the pre-push checks and refuses to destroy data:

1. **Refuse in a worktree** — only runs in the repo's main worktree, not in a
   linked `git worktree`.
2. **Clean index** — aborts if there are staged, unstaged, or untracked files.
3. **dev ahead of master** — fetches `origin`, verifies `origin/dev` is a
   descendant of `origin/master` and strictly ahead.
4. **Merge dev into master** — fast-forward only; never creates a merge commit
   and never rewrites history.
5. **Collect the changelog** — validate `architecture/unreleased/*.md`, skipping
   `README.md`: every non-empty line must start with `- [`. Prepend the bullets
   under `## vX.Y.Z (YYYY-MM-DD)` (next patch from the current package version),
   ordered by PR number descending, then slug filename ascending. Commit the
   changelog and fragment removals together as `docs: changelog for vX.Y.Z`.
   Abort naming any invalid fragment before writing. No fragments: log and continue.
6. **Push master** — plain `git push origin master`; no force.
7. **Wait for CI** — polls `origin` until `origin/master` advances past the
   pushed commit (the `[skip ci]` bump commit) AND a new `vX.Y.Z` tag appears.
   20-minute hard cap.
8. **Pull master** — fast-forwards local `master` to `origin/master`.
9. **Reset dev to master** — fast-forwards `dev` onto `master` and pushes
   `dev`. Never force-updates or rewrites `dev`.
10. **Verify publication** — only after the git updates, find `publish.yml` for
    the originally pushed master commit and wait for success (20 minutes by
    default, override with `PUBLISH_MAX_WAIT_SEC`). Then poll `npm view` with
    `--prefer-online` until every non-private `@vworlds/*` workspace's `latest`
    equals the new version (10 minutes, override with `REGISTRY_MAX_WAIT_SEC`).
    Log the package count, each verified version, and a final count/time summary.
    `POLL_INTERVAL_SEC` sets the poll interval (default 15 seconds); `MAX_WAIT_SEC`
    sets the earlier tag wait (default 20 minutes). Use positive integer seconds.

## How CI bumps the version

`.github/workflows/publish.yml` runs on every push to `master`. It runs
`scripts/bump-vecs-versions.mjs` (patch bump), commits the bumped
`package.json`/`package-lock.json` with `chore: bump vecs packages [skip ci]`,
tags `vX.Y.Z`, and pushes the commit + tag to `master`. The next release will
be `v1.0.36`.

## What the agent should do

1. Read `.agents/rules/commits.md` and `.agents/workflows/pr-workflow.md` for
   context (the release script follows the same no-force, fast-forward-only
   discipline).
2. Confirm the fragments in `architecture/unreleased/` reflect the changes to be
   published accurately and cover significant features / bugfixes since the last
   release. Check their [format](../../../architecture/unreleased/README.md) with
   `scripts/agent/check-changelog.sh`. If changes are missing, propose a fragment
   and ask for confirmation.
3. Confirm the user wants to release now; the script pushes to `master` and
   triggers a public npm publish.
4. Run the script and stream its output. Report the new version tag when it
   completes.
5. **Verification is automatic:** the script waits for the publish run and the
   registry. A failed publish reports its run URL: inspect that run and ask how
   to proceed; do not rerun the release. A publish timeout means the run is still
   pending or could not be found/read: inspect Actions before retrying verification.
   A registry timeout names the packages still behind (including unavailable npm
   responses). Git is already complete; nothing needs repairing in git. Wait and
   retry verification only, not the release. To rerun just verification from the
   repo root, supply the **original push SHA** (not the bump SHA) and version:

   ```bash
   (
     set -euo pipefail
     log() { printf '[release] %s\n' "$*"; }
     err() { printf '[release][error] %s\n' "$*" >&2; }
     . scripts/lib/release-publish.sh
     wait_release_publish ORIGINAL_PUSH_SHA X.Y.Z
   )
   ```

   The helper uses Node's workspace glob discovery and the system `timeout`
   command to bound `gh`/`npm` requests by the remaining deadline.

6. If the script fails earlier, do NOT attempt to fix git state by hand. Surface the
   error and the script's suggested remediation, and ask the user how to
   proceed.

## Safety

- Never run `git reset --hard`, `git push --force`, or `git branch -D` as part
  of a release. The script never does either.
- Never commit on `master` directly; all changes land on `dev` first.
- The script leaves the working tree on `dev` when it finishes.

## Branch test releases (beta)

Use a beta when a consumer needs to test an unreleased branch through normal npm
installation, including its new dependencies. This is a public publish: confirm
the owner wants it before dispatching. Do not run the stable release script.

From any checkout containing the beta tooling, run:

```bash
bash scripts/orchestrator/publish-beta.sh pack/idle-keepalive
```

The remote branch must already contain the dispatch-capable `publish.yml` and
beta tooling. GitHub also requires `workflow_dispatch` on the repository's
default branch before the workflow can be dispatched. Trusted publishing stays
in the existing `publish.yml`; no additional npm trusted publisher is needed.

The script dispatches that branch, correlates its own run with a unique request
ID, waits for success, and verifies all nine packages on npm. The beta job checks
out the dispatched ref, installs, tests, sets versions, builds, prepares, and
publishes. It never commits, tags, or pushes. `master` and tag refs are refused.
There is no local `npm publish`.

Versions are the next patch of the dispatched commit's synchronized package
version, followed by `-<slug>.<github.run_number>`. For example,
`1.0.56-pack-idle-keepalive.7`. Slugs lowercase the branch and replace every run
outside `[a-z0-9]` with `-` (without trimming). All nine packages use the same
version and exact internal dependency pins. External dependencies are unchanged.
Branches producing `latest` or numeric/version-like npm tags are rejected; rename
them to a descriptive branch starting with a letter.

Betas **never move `latest`**. Every publish explicitly uses the branch slug as
its npm dist-tag. Consumers can install the printed exact version (reproducible),
or the branch dist-tag (which moves on subsequent successful publishes):

```bash
npm i @vworlds/vecs@1.0.56-pack-idle-keepalive.7
npm i @vworlds/vecs@pack-idle-keepalive
```

Install any other vecs packages you use at the same version or tag. Different
branches may normalize to the same slug; choose distinct slugs when they must
retain independent tags. Workflow reruns reuse the same version, so do not rerun
a partially published beta blindly: inspect the run and registry first.

When pinning a beta in a consumer checkout, editing manifests (including root
`overrides`) and running `npm install` can update lockfile entries while leaving
`node_modules/@vworlds/*` at the old version; `npm ls` may not make the mismatch
obvious. To refresh reliably, remove the `node_modules/@vworlds/vecs*` entries
from `package-lock.json`, delete those installed directories, and install again.
Then verify the installed version against the registry, for example:

```bash
npm view @vworlds/vecs@pack-idle-keepalive version
node -p 'require("@vworlds/vecs/package.json").version'
```

The publish wait defaults to 20 minutes (`PUBLISH_MAX_WAIT_SEC`), registry
propagation to 10 minutes (`REGISTRY_MAX_WAIT_SEC`), and polling to 15 seconds
(`POLL_INTERVAL_SEC`). All accept positive integer seconds; requests are bounded
by the remaining deadline. A failed/timeout run prints its URL when available.
If the registry alone is late, retry verification rather than dispatching another
public release. To verify an existing beta again, from the repo root:

```bash
(
  set -euo pipefail
  log() { printf '[beta] %s\n' "$*"; }
  err() { printf '[beta][error] %s\n' "$*" >&2; }
  . scripts/lib/release-publish.sh
  packages=$(node --input-type=module -e 'import { betaPackageNames } from "./scripts/beta-versions.mjs"; console.log(betaPackageNames.map(n=>`@vworlds/${n}`).join("\n"))')
  wait_beta_registry 1.0.56-pack-idle-keepalive.7 pack-idle-keepalive "$packages"
)
```

To stop advertising a branch, an authorized npm maintainer can remove its tag
from **each of the nine packages**, for example:

```bash
npm dist-tag rm @vworlds/vecs pack-idle-keepalive
```

Removing a tag does not delete published versions or break exact-version installs.
To warn users off a particular version, deprecate that version on each package
with `npm deprecate @vworlds/vecs@1.0.56-pack-idle-keepalive.7 'Test release retired'`.
Neither cleanup operation changes `latest`; do not unpublish versions as routine
beta cleanup.
