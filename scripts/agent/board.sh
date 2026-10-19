#!/bin/sh
# vmethod stub
root=${VMETHOD_ROOT:-}
if [ -z "$root" ] && command -v git > /dev/null 2>&1; then
  if ! root=$(git rev-parse --show-toplevel); then
    echo "vmethod: git could not find a repository; set VMETHOD_ROOT" >&2
    root=
  fi
fi
if [ -z "$root" ] || [ ! -x "$root/node_modules/.bin/vmethod" ]; then
  echo "vmethod: run npm ci (set VMETHOD_ROOT when no repository is available)" >&2
  exit 2
fi
exec "$root/node_modules/.bin/vmethod" board "$@"
