# Kanban board helpers (the GitHub project the owner tracks work on). Source it after common.sh;
# don't run it. Columns, assignees and who moves cards: .agents/workflows/orchestrator.md, "The board".
# shellcheck shell=bash

BOARD_PROJECT="${VECS_BOARD_PROJECT:-PVT_kwDOBvP9TM4Bmegb}"
# The owner's GitHub login: an item assigned to them is waiting for them.
BOARD_OWNER="${VECS_OWNER:-jpeletier}"
# Shared with watch-prs.sh, which reports cards that change column.
BOARD_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/vecs-watch/board"

# VECS_BOARD=off turns every board step into a no-op (forks, tests, offline work).
board_enabled() { [ "${VECS_BOARD:-on}" != off ]; }

# board_column <name>: the canonical column name; accepts any case and the short forms.
board_column() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' _-')" in
    backlog) echo "Backlog" ;;
    ready) echo "Ready" ;;
    inprogress | progress) echo "In progress" ;;
    inreview | review) echo "In review" ;;
    approved) echo "Approved" ;;
    done) echo "Done" ;;
    *) return 1 ;;
  esac
}

_board_gql() { retry 3 gh api graphql -f p="$BOARD_PROJECT" "$@"; }

# board_meta: one "<statusFieldId> TAB <optionId> TAB <column>" line per column, looked up by
# name so the scripts survive a column being recreated.
board_meta() {
  if [ -z "${_BOARD_META:-}" ]; then
    _BOARD_META="$(_board_gql -f query='
      query($p: ID!) { node(id: $p) { ... on ProjectV2 { field(name: "Status") {
        ... on ProjectV2SingleSelectField { id options { id name } } } } } }' \
      --jq '.data.node.field as $f | $f.options[] | [$f.id, .id, .name] | @tsv')" || return 1
  fi
  printf '%s\n' "$_BOARD_META"
}

# board_items: every card in board order (top to bottom), as TSV:
#   itemId, column, kind (PR, ISSUE or DRAFT), repo, number, state, title, assignees
# Assignees are logins joined by commas, or "-".
board_items() {
  local cursor="" page
  while :; do
    page="$(_board_gql ${cursor:+-f after="$cursor"} -f query='
      query($p: ID!, $after: String) { node(id: $p) { ... on ProjectV2 {
        items(first: 100, after: $after, orderBy: {field: POSITION, direction: ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes { id
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name } }
            content { __typename
              ... on DraftIssue { title }
              ... on Issue { number title state repository { nameWithOwner }
                assignees(first: 10) { nodes { login } } }
              ... on PullRequest { number title state repository { nameWithOwner }
                assignees(first: 10) { nodes { login } } } } } } } } }')" ||
      return 1
    jq -r '.data.node.items.nodes[] | [ .id, (.status.name // "-"),
        ({"PullRequest": "PR", "Issue": "ISSUE", "DraftIssue": "DRAFT"}[.content.__typename // ""] // "?"),
        (.content.repository.nameWithOwner // "-"), ((.content.number // "-") | tostring),
        (.content.state // "-"), ((.content.title // "") | gsub("[\t\r\n]"; " ")),
        ([.content.assignees.nodes[]?.login] | if length == 0 then "-" else join(",") end) ] | @tsv' <<< "$page"
    [ "$(jq -r '.data.node.items.pageInfo.hasNextPage' <<< "$page")" = true ] || break
    cursor="$(jq -r '.data.node.items.pageInfo.endCursor' <<< "$page")"
  done
}

# board_ref <ref>: "<repo> TAB <number>" for 212, #212, owner/repo#212 or a github.com URL.
board_ref() {
  local ref="${1#\#}"
  if [[ "$ref" =~ ^[0-9]+$ ]]; then
    printf '%s\t%s\n' "$REPO_SLUG" "$ref"
  elif [[ "$ref" =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([0-9]+)$ ]]; then
    printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  elif [[ "$ref" =~ github\.com/([^/]+/[^/]+)/(issues|pull)/([0-9]+) ]]; then
    printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
  else
    return 1
  fi
}

# board_item <ref>: the card's item id, adding the issue or PR to the board if it isn't there
# (adding an existing one returns its card). A PVTI_… id passes through.
board_item() {
  local repo="" number="" node
  case "$1" in PVTI_*) printf '%s\n' "$1"; return 0 ;; esac
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || { log "board: cannot read '$1' as an issue or PR"; return 1; }
  node="$(retry 3 gh api "repos/$repo/issues/$number" --jq .node_id)" || return 1
  _board_gql -f c="$node" -f query='
    mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) {
      item { id } } }' --jq '.data.addProjectV2ItemById.item.id'
}

# board_remember <itemId> <column>: note a move made by these scripts, so the watcher doesn't
# report it back to its author.
board_remember() { mkdir -p "$BOARD_STATE" && printf '%s\n' "$2" > "$BOARD_STATE/$1"; }

# board_set <itemId> <column>
board_set() {
  local item="$1" column field="" option=""
  column="$(board_column "$2")" || { log "board: unknown column '$2'"; return 1; }
  IFS=$'\t' read -r field option _ < <(board_meta | awk -F'\t' -v c="$column" '$3 == c') || true
  [ -n "$option" ] || { log "board: the Status field has no '$column' option"; return 1; }
  _board_gql -f i="$item" -f f="$field" -f o="$option" -f query='
    mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: {
      projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}}) {
      projectV2Item { id } } }' > /dev/null || return 1
  board_remember "$item" "$column"
}

# board_place <itemId> top|bottom|<itemId to sit below>: reorder a card. Order is one ranking
# for the whole board, so the top of the board is also the top of the card's column.
board_place() {
  local item="$1" after=""
  case "$2" in
    top) ;;
    bottom) after="$(board_items | cut -f1 | grep -v -x "$item" | tail -1)" ;;
    PVTI_*) after="$2" ;;
    *) return 1 ;;
  esac
  _board_gql -f i="$item" ${after:+-f a="$after"} -f query='
    mutation($p: ID!, $i: ID!, $a: ID) { updateProjectV2ItemPosition(input: {
      projectId: $p, itemId: $i, afterId: $a}) { clientMutationId } }' > /dev/null
}

# board_archive <itemId>: take a card off the board without deleting its issue or PR.
board_archive() {
  _board_gql -f i="$1" -f query='
    mutation($p: ID!, $i: ID!) { archiveProjectV2Item(input: {projectId: $p, itemId: $i}) {
      clientMutationId } }' > /dev/null && rm -f "$BOARD_STATE/$1"
}

# board_move <ref> <column> [top|bottom]: put a card in a column, adding it to the board first
# if needed. Returns non-zero on failure; callers inside another step use `|| true`, because a
# board problem must never break a merge or a task launch.
board_move() {
  board_enabled || return 0
  local item
  if item="$(board_item "$1")" && [ -n "$item" ] && board_set "$item" "$2"; then
    [ -z "${3:-}" ] || board_place "$item" "$3" || log "board: could not reorder $1"
    log "board: $1 → $(board_column "$2")"
  else
    log "warning: board not updated ($1 → $2); fix it with scripts/orchestrator/board.sh move"
    return 1
  fi
}

# board_where <ref>: the column an issue's or PR's card is in; nothing if it has no card.
board_where() {
  local repo="" number=""
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || return 1
  board_items | awk -F'\t' -v r="$repo" -v n="$number" '$4 == r && $5 == n { print $2; exit }'
}

# board_beside <ref> <anchor ref>: rank a card right below another one (a task PR under its issue).
board_beside() {
  board_enabled || return 0
  local item anchor
  item="$(board_item "$1")" && anchor="$(board_item "$2")" && [ -n "$item" ] && [ -n "$anchor" ] || return 1
  board_place "$item" "$anchor"
}

# board_me: the login these scripts act as.
board_me() {
  [ -n "${_BOARD_ME:-}" ] || _BOARD_ME="$(retry 3 gh api user --jq .login)" || return 1
  printf '%s\n' "$_BOARD_ME"
}

# board_login owner|me|<login>
board_login() {
  case "$1" in
    owner) printf '%s\n' "$BOARD_OWNER" ;;
    me) board_me ;;
    *) printf '%s\n' "$1" ;;
  esac
}

_board_assignees() { # <POST|DELETE> <repo> <number> <login>
  retry 3 gh api -X "$1" "repos/$2/issues/$3/assignees" -f "assignees[]=$4" > /dev/null
}

# board_turn <ref> owner|me|nobody: say whose move an issue or PR is. The assignee is the one who
# must act: the owner (read, playtest, decide), these scripts' login (the orchestrator), or
# nobody (a worker has it, or it is finished). Other assignees are left alone.
board_turn() {
  board_enabled || return 0
  local repo="" number="" me give="" take=""
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || { log "board: cannot read '$1' as an issue or PR"; return 1; }
  me="$(board_me)" || return 1
  case "$2" in
    owner) give="$BOARD_OWNER" take="$me" ;;
    me) give="$me" take="$BOARD_OWNER" ;;
    nobody) take="$BOARD_OWNER $me" ;;
    *) log "board: turn is owner, me or nobody"; return 1 ;;
  esac
  for who in $take; do _board_assignees DELETE "$repo" "$number" "$who" || true; done
  # When we take the owner off, tell the watcher, so it doesn't report it back as their doing.
  case " $take " in *" $BOARD_OWNER "*) mkdir -p "$BOARD_STATE" && touch "$BOARD_STATE/.turn-${repo//\//_}-$number" ;; esac
  if [ -n "$give" ]; then
    _board_assignees POST "$repo" "$number" "$give" ||
      { log "warning: could not assign #$number to $give"; return 1; }
  fi
  # Taking something ourselves is not news either: the watcher keeps "mine-<n>" for what it has
  # already reported as assigned to us.
  if [ "$2" = me ] && [ "$repo" = "$REPO_SLUG" ]; then touch "${BOARD_STATE%/board}/mine-$number"; fi
  log "board: #$number is now ${give:-nobody}'s move"
}

# board_blockers <ref>: the open issues that block an issue ("blocked by" relations), one
# "<number> TAB <title>" per line. Nothing printed means it can be started.
board_blockers() {
  local repo="" number=""
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || return 1
  retry 3 gh api --paginate "repos/$repo/issues/$number/dependencies/blocked_by" \
    --jq '.[] | select(.state == "open") | "\(.number)\t\(.title)"'
}

# board_block <issue> <blocker…> / board_unblock <issue> <blocker…>: add or remove "blocked by"
# relations. Adding one that exists is not an error.
board_block() {
  local repo="" number="" id blocker
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || return 1
  shift
  for blocker in "$@"; do
    blocker="${blocker#\#}"
    if gh api "repos/$repo/issues/$number/dependencies/blocked_by" --jq '.[].number' 2> /dev/null |
      grep -q -x "$blocker"; then
      continue
    fi
    id="$(retry 3 gh api "repos/$repo/issues/$blocker" --jq .id)" || return 1
    retry 3 gh api -X POST "repos/$repo/issues/$number/dependencies/blocked_by" -F issue_id="$id" \
      > /dev/null || return 1
    log "#$number is blocked by #$blocker"
  done
}
board_unblock() {
  local repo="" number="" id blocker
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || return 1
  shift
  for blocker in "$@"; do
    blocker="${blocker#\#}"
    id="$(retry 3 gh api "repos/$repo/issues/$blocker" --jq .id)" || return 1
    gh api -X DELETE "repos/$repo/issues/$number/dependencies/blocked_by/$id" > /dev/null 2>&1 &&
      log "#$number is no longer blocked by #$blocker"
  done
}
