#!/bin/sh
set -eu

vars_file="${VECS_VARS_FILE:-/usr/share/nginx/html/vars.js}"

if [ ! -f "$vars_file" ]; then
  echo "Missing $vars_file; cannot apply vecs connection overrides" >&2
  exit 1
fi

has_overrides=false

append_header() {
  if [ "$has_overrides" = false ]; then
    printf '\n// Runtime vecs connection overrides.\n' >> "$vars_file"
    has_overrides=true
  fi
}

append_number_override() {
  name="$1"
  value="$2"

  if [ -z "$value" ]; then
    return 0
  fi

  case "$value" in
    *[!0-9]*)
      echo "VECS_PORT must be a number" >&2
      exit 1
      ;;
  esac

  append_header
  printf 'window.vecsConnectionOptions.%s=%s;\n' "$name" "$value" >> "$vars_file"
}

append_string_override() {
  name="$1"
  value="$2"

  if [ -z "$value" ]; then
    return 0
  fi

  escaped_value=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g')

  append_header
  printf 'window.vecsConnectionOptions.%s="%s";\n' "$name" "$escaped_value" >> "$vars_file"
}

append_string_override host "${VECS_HOST:-}"
append_number_override port "${VECS_PORT:-}"
append_string_override protocol "${VECS_PROTOCOL:-}"
append_string_override worldName "${VECS_WORLD_NAME:-}"
append_string_override apiBasePath "${VECS_API_BASE_PATH:-}"
