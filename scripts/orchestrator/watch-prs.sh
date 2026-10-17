#!/bin/sh
# vmethod stub
# Legacy entry point; use vmethod watch for new sessions.
root=${VMETHOD_ROOT:-}
if [ -z "$root" ]; then root=$(git rev-parse --show-toplevel) || exit 2; fi
if [ ! -x "$root/node_modules/.bin/vmethod" ]; then
  echo "vmethod: run npm ci" >&2
  exit 2
fi
exec "$root/node_modules/.bin/vmethod" watch "$@"
