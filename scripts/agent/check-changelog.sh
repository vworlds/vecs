#!/usr/bin/env bash
# Validate pending changelog fragments without modifying the working tree.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
. scripts/lib/changelog.sh
validate_changelog_fragments
