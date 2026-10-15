# Kanban board helpers (the GitHub project the owner tracks work on). Source it after common.sh;
# don't run it. Columns, assignees and who moves cards: .agents/workflows/orchestrator.md, "The board".
# shellcheck shell=bash

BOARD_PROJECT="${VECS_BOARD_PROJECT:-PVT_kwDOBvP9TM4Bmegb}"
# The owner's GitHub login: an item assigned to them is waiting for them.
BOARD_OWNER="${VECS_OWNER:-jpeletier}"
# Items belong to a track by label, or through a task PR's issue reference.
VECS_TRACK="${VECS_TRACK:-}"
VECS_BASE="${VECS_BASE:-dev}"
WATCH_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/vecs-watch${VECS_TRACK:+-$VECS_TRACK}"
# Shared with watch-prs.sh, which reports cards that change column.
BOARD_STATE="$WATCH_STATE/board"

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

# board_items [filter]: every card in board order (top to bottom), as TSV:
#   itemId, column, kind (PR, ISSUE or DRAFT), repo, number, state, title, assignees
# Assignees are logins joined by commas, or "-". <filter> is a project filter such as
# "-status:Done": whoever doesn't need the Done column leaves it out, because it only grows and
# every 100 cards cost another request.
board_items() {
  local filter="${1:-}" cursor="" page
  while :; do
    page="$(_board_gql ${cursor:+-f after="$cursor"} ${filter:+-f q="$filter"} -f query='
      query($p: ID!, $after: String, $q: String) { node(id: $p) { ... on ProjectV2 {
        items(first: 100, after: $after, query: $q, orderBy: {field: POSITION, direction: ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes { id
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name } }
            content { __typename
              ... on DraftIssue { title }
              ... on Issue { number title state repository { nameWithOwner }
                assignees(first: 10) { nodes { login } } }
              ... on PullRequest { number title state repository { nameWithOwner }
                assignees(first: 10) { nodes { login } } } } } } } } }')" \
      || return 1
    jq -r '.data.node.items.nodes[] | [ .id, (.status.name // "-"),
        ({"PullRequest": "PR", "Issue": "ISSUE", "DraftIssue": "DRAFT"}[.content.__typename // ""] // "?"),
        (.content.repository.nameWithOwner // "-"), ((.content.number // "-") | tostring),
        (.content.state // "-"), ((.content.title // "") | gsub("[\t\r\n]"; " ")),
        ([.content.assignees.nodes[]?.login] | if length == 0 then "-" else join(",") end) ] | @tsv' <<< "$page"
    [ "$(jq -r '.data.node.items.pageInfo.hasNextPage' <<< "$page")" = true ] || break
    cursor="$(jq -r '.data.node.items.pageInfo.endCursor' <<< "$page")"
  done
}

# board_first_unblocked <rows>: "#n (KIND): title" of the first "number TAB kind TAB title" row
# with no open blocker, or nothing. Fails when the blockers cannot be read.
board_first_unblocked() {
  local number kind title blocked
  while IFS=$'\t' read -r number kind title; do
    [ -n "${number:-}" ] || continue
    if [ "$kind" = ISSUE ]; then
      blocked="$(board_blockers "$number" 2> /dev/null | head -1)" || return 1
      [ -z "$blocked" ] || continue
    fi
    printf '#%s (%s): %s\n' "$number" "$kind" "$title"
    return 0
  done <<< "$1"
}

# board_ready_rows / board_approved_rows <items>: this repo's Ready cards, and its approved
# issues, as "number TAB kind TAB title", in board order.
board_ready_rows() {
  awk -F'\t' -v here="$REPO_SLUG" '$2 == "Ready" && $4 == here { print $5 "\t" $3 "\t" $7 }' <<< "$1"
}
board_approved_rows() {
  awk -F'\t' -v here="$REPO_SLUG" '$2 == "Approved" && $4 == here && $3 == "ISSUE" { print $5 "\t" $3 "\t" $7 }' <<< "$1"
}

# board_hold_startable / board_release_startable: keep NEXT and LAUNCH quiet while our merge
# is in flight. A hold older than two minutes is ignored so a failed script cannot silence them.
board_hold_startable() {
  board_enabled || return 0
  mkdir -p "$BOARD_STATE" && touch "$BOARD_STATE/.hold-startable"
}
board_release_startable() { rm -f "$BOARD_STATE/.hold-startable"; }
board_startable_held() {
  local f="$BOARD_STATE/.hold-startable"
  [ -e "$f" ] && [ $(($(date +%s) - $(stat -c %Y "$f" 2> /dev/null || echo 0))) -lt 120 ]
}

# board_archive_done [keep]: Done shows the <keep> most recently closed cards (default 6); archive
# this repo's cards that closed before them. Other repos (vecs shares the board) count towards the
# <keep> but are left to their own sessions. Archived cards stay in "Archived items" and can be restored.
board_archive_done() {
  board_enabled || return 0
  local keep="${1:-6}" cursor="" page cards="" ids id n=0
  [[ "$keep" =~ ^[0-9]+$ ]] || {
    log "board: archive keeps a number of cards, not '$keep'"
    return 2
  }
  # Collect first: archiving while paging would shift the pages.
  while :; do
    page="$(_board_gql ${cursor:+-f after="$cursor"} -f query='
      query($p: ID!, $after: String) { node(id: $p) { ... on ProjectV2 {
        items(first: 100, after: $after, query: "status:Done") {
          pageInfo { hasNextPage endCursor }
          nodes { id content {
            ... on Issue { closedAt repository { nameWithOwner } }
            ... on PullRequest { closedAt repository { nameWithOwner } } } } } } } }')" \
      || return 1
    cards+="$(jq -r '.data.node.items.nodes[] | select(.content.closedAt != null)
      | [.content.closedAt, .content.repository.nameWithOwner, .id] | @tsv' <<< "$page")"$'\n'
    [ "$(jq -r '.data.node.items.pageInfo.hasNextPage' <<< "$page")" = true ] || break
    cursor="$(jq -r '.data.node.items.pageInfo.endCursor' <<< "$page")"
  done
  # ISO 8601 UTC timestamps sort lexically; rank all repos together before filtering ours.
  ids="$(sort -r <<< "$cards" | awk -F'\t' -v keep="$keep" -v here="$REPO_SLUG" \
    'NF { n++ } NF && n > keep && $2 == here { print $3 }')"
  for id in $ids; do
    _board_gql -f i="$id" -f query='
      mutation($p: ID!, $i: ID!) { archiveProjectV2Item(input: {projectId: $p, itemId: $i}) {
        item { id } } }' > /dev/null || continue
    rm -f "$BOARD_STATE/$id" "$BOARD_STATE/$id.who"
    n=$((n + 1))
  done
  [ "$n" -eq 0 ] || log "board: archived $n Done card(s); Done keeps the $keep most recently closed"
}

# board_announce_startable: after a step of ours that can unblock cards (a merge closes
# issues), say what can be started now and record it as already reported, so the watcher
# doesn't wake its own author for it a few seconds later.
board_announce_startable() {
  board_enabled || return 0
  local items next launch
  items="$(board_items "-status:Done" 2> /dev/null)" || return 0
  board_load_tracks "$WATCH_STATE/tracks" 2> /dev/null || return 0
  next="$(board_first_unblocked "$(board_ours_rows "$(board_ready_rows "$items")")")" || return 0
  launch="$(board_first_unblocked "$(board_ours_rows "$(board_approved_rows "$items")")")" || return 0
  mkdir -p "$BOARD_STATE"
  if [ "$next" != "$(cat "$BOARD_STATE/.next" 2> /dev/null || true)" ]; then
    printf '%s\n' "$next" > "$BOARD_STATE/.next"
    [ -z "$next" ] || log "next: $next"
  fi
  if [ "$launch" != "$(cat "$BOARD_STATE/.launch" 2> /dev/null || true)" ]; then
    printf '%s\n' "$launch" > "$BOARD_STATE/.launch"
    [ -z "$launch" ] || log "launch: $launch: approved and nothing blocks it"
  fi
}

# Track membership snapshot. Item listings are REST-only (no additional GraphQL budget).
declare -A BOARD_TRACK=() BOARD_KNOWN=()
BOARD_LISTED=false
board_tracks() {
  retry 3 gh api --paginate "repos/$REPO_SLUG/issues?state=open&per_page=100" | jq -rs '
    add as $all
    | def track: [.labels[].name | select(startswith("track:")) | ltrimstr("track:")][0];
    ([$all[] | select(.pull_request | not) | select(track) | {key: (.number | tostring), value: track}] | from_entries) as $issues
    | $all[] | (track // (if .pull_request then
        [(.body // "") | scan("(?i)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\\s+#([0-9]+)") | .[0] | $issues[.] // empty][0]
      else null end) // "-") as $track
    | "\(.number)\t\($track)"'
}
board_load_tracks() {
  local file="${1:-}" rows number track
  rows="$(board_tracks)" || return 1
  if [ -n "$file" ] && [ -r "$file" ]; then
    while IFS=$'\t' read -r number track; do
      [ -n "${number:-}" ] || continue
      BOARD_KNOWN[$number]=1
      [ "$track" = - ] || BOARD_TRACK[$number]="$track"
    done < "$file"
  fi
  while IFS=$'\t' read -r number track; do
    [ -n "${number:-}" ] || continue
    BOARD_KNOWN[$number]=1
    if [ "$track" = - ]; then unset 'BOARD_TRACK[$number]'; else BOARD_TRACK[$number]="$track"; fi
  done <<< "$rows"
  BOARD_LISTED=true
  if [ -n "$file" ]; then
    mkdir -p "$(dirname "$file")"
    for number in "${!BOARD_TRACK[@]}"; do printf '%s\t%s\n' "$number" "${BOARD_TRACK[$number]}"; done > "$file.tmp" && mv "$file.tmp" "$file"
  fi
}
board_track_one() {
  local item track issue
  BOARD_KNOWN[$1]=1
  item="$(retry 2 gh api "repos/$REPO_SLUG/issues/$1" 2> /dev/null)" || return 1
  track="$(jq -r '[.labels[].name | select(startswith("track:")) | ltrimstr("track:")][0] // empty' <<< "$item")"
  if [ -z "$track" ] && [ "$(jq -r 'has("pull_request")' <<< "$item")" = true ]; then
    while read -r issue; do
      track="${BOARD_TRACK[$issue]:-}"
      [ -z "$track" ] || break
    done < <(jq -r '(.body // "") | [scan("(?i)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\\s+#([0-9]+)") | .[0]] | .[]' <<< "$item")
  fi
  [ -z "$track" ] || BOARD_TRACK[$1]="$track"
}
board_ours() {
  if $BOARD_LISTED && [ -z "${BOARD_KNOWN[$1]:-}" ] && [[ "$1" =~ ^[1-9][0-9]*$ ]]; then board_track_one "$1" || true; fi
  [ "${BOARD_TRACK[$1]:-}" = "$VECS_TRACK" ]
}
board_ours_rows() {
  local number rest
  while IFS=$'\t' read -r number rest; do
    [ -n "${number:-}" ] && board_ours "$number" && printf '%s\t%s\n' "$number" "$rest"
  done <<< "$1"
  return 0
}
board_require_ours() {
  board_load_tracks "$WATCH_STATE/tracks" || die "cannot read the tracks"
  board_ours "$1" || die "#$1 is in track '${BOARD_TRACK[$1]:-none}', this session runs '${VECS_TRACK:-none}' (VECS_TRACK)"
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
board_lookup_item() {
  local repo="$1" number="$2" node
  node="$(retry 3 gh api "repos/$repo/issues/$number" --jq .node_id)" || return 1
  gh api graphql -f c="$node" -f query='
    query($c: ID!) { node(id: $c) { ... on Issue { projectItems(first: 100) { nodes {
      id projectV2 { id } status: fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name } }
    } } } } }' --jq '.data.node.projectItems.nodes[] | select(.projectV2.id == "'"$BOARD_PROJECT"'") | [.id, (.status.name // "-")] | @tsv'
}
board_item() {
  local repo="" number="" node item existing
  case "$1" in PVTI_*)
    printf '%s\n' "$1"
    return 0
    ;;
  esac
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || {
    log "board: cannot read '$1' as an issue or PR"
    return 1
  }
  item="$(board_items 2> /dev/null | awk -F'\t' -v r="$repo" -v n="$number" '$4 == r && $5 == n { print $1; exit }')" || true
  if [ -n "$item" ]; then
    printf '%s\n' "$item"
    return 0
  fi
  node="$(retry 3 gh api "repos/$repo/issues/$number" --jq .node_id)" || return 1
  existing="$(gh api graphql -f c="$node" -f query='
    query($c: ID!) { node(id: $c) { ... on Issue { projectItems(first: 100) { nodes {
      id projectV2 { id }
    } } } } }' --jq '.data.node.projectItems.nodes[] | select(.projectV2.id == "'"$BOARD_PROJECT"'") | .id' 2> /dev/null || true)"
  if [ -n "$existing" ]; then
    printf '%s\n' "${existing%%$'\t'*}"
    return 0
  fi
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
  column="$(board_column "$2")" || {
    log "board: unknown column '$2'"
    return 1
  }
  IFS=$'\t' read -r field option _ < <(board_meta | awk -F'\t' -v c="$column" '$3 == c') || true
  [ -n "$option" ] || {
    log "board: the Status field has no '$column' option"
    return 1
  }
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

# Progress is a machine-maintained summary of what a card waits on: <state>[ 🔁<round>][ 🔴].
declare -A PROGRESS_STATES=(
  [hold]="⛔" [working]="🤖🔨" [question]="🤖❓" [design]="🤖📐" [blocked]="🤖🚫"
  [ready]="🤖👍" [verifying]="🧭🔍" ["owner-review"]="👤🔍" ["owner-question"]="👤❓"
  [conflict]="💥" [silent]="⏳" [permission]="🔑" [failed]="🪫" [idle]="💤"
)
PROGRESS_STUCK="silent permission failed idle conflict"

_progress_field() {
  if [ -z "${_PROGRESS_FIELD:-}" ]; then
    _PROGRESS_FIELD="$(_board_gql -f query='query($p: ID!) { node(id: $p) { ... on ProjectV2 { field(name: "Progress") { ... on ProjectV2Field { id } } } } }' --jq '.data.node.field.id // empty')" || return 1
    [ -n "$_PROGRESS_FIELD" ] || {
      log "board: the project has no Progress field"
      return 1
    }
  fi
  printf '%s\n' "$_PROGRESS_FIELD"
}

progress_round() { sed 's/[0-9]/&\xef\xb8\x8f\xe2\x83\xa3/g' <<< "$1"; }
progress_text() {
  local parts=() IFS=' '
  [ "$1" = - ] || parts+=("${PROGRESS_STATES[$1]}")
  [ "$2" = - ] || parts+=("🔁$(progress_round "$2")")
  [ "$3" != red ] || parts+=("🔴")
  printf '%s' "${parts[*]}"
}
progress_parse() {
  local word state=- round=- ci=- name
  for word in $1; do
    case "$word" in
      🔁*)
        round="$(tr -cd '0-9' <<< "$word")"
        [ -n "$round" ] || round=-
        ;;
      🔴) ci=red ;;
      *) for name in "${!PROGRESS_STATES[@]}"; do [ "${PROGRESS_STATES[$name]}" = "$word" ] && state="$name"; done ;;
    esac
  done
  printf '%s\t%s\t%s\n' "$state" "$round" "$ci"
}

# board_progress <ref> [state=<name>|-] [round=<n>|-] [ci=red|ok] [if=<state,...>]
board_progress() {
  board_enabled || return 0
  local ref="$1" item field cur state round ci only='' arg want='' new
  shift
  item="$(board_item "$ref")" && [ -n "$item" ] || {
    log "board: no card for $ref"
    return 1
  }
  field="$(_progress_field)" || return 1
  cur="$(_board_gql -f i="$item" -f query='query($i: ID!) { node(id: $i) { ... on ProjectV2Item { fieldValueByName(name: "Progress") { ... on ProjectV2ItemFieldTextValue { text } } } } }' --jq '.data.node.fieldValueByName.text // ""')" || return 1
  IFS=$'\t' read -r state round ci < <(progress_parse "$cur")
  for arg in "$@"; do
    case "$arg" in
      state=*) want="${arg#state=}" ;;
      round=*) round="${arg#round=}" ;;
      ci=red) ci=red ;;
      ci=ok) ci=- ;;
      if=*) only="${arg#if=}" ;;
      *)
        log "board: unknown Progress part '$arg'"
        return 1
        ;;
    esac
  done
  if [ -n "$only" ] && [[ ",$only," != *",$state,"* ]]; then return 0; fi
  if [ -n "$want" ]; then
    [ "$want" = - ] || [ -n "${PROGRESS_STATES[$want]:-}" ] || {
      log "board: unknown Progress state '$want'"
      return 1
    }
    state="$want"
  fi
  new="$(progress_text "$state" "$round" "$ci")"
  [ "$new" != "$cur" ] || return 0
  if [ -z "$new" ]; then
    _board_gql -f i="$item" -f f="$field" -f query='mutation($p: ID!, $i: ID!, $f: ID!) { clearProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f}) { projectV2Item { id } } }' > /dev/null || return 1
  else
    _board_gql -f i="$item" -f f="$field" -f t="$new" -f query='mutation($p: ID!, $i: ID!, $f: ID!, $t: String!) { updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: {text: $t}}) { projectV2Item { id } } }' > /dev/null || return 1
  fi
  log "board: $ref progress ${new:-cleared}"
}
board_progress_clear() { board_progress "$1" state=- round=- ci=ok; }

# board_where <ref>: the column an issue's or PR's card is in; nothing if it has no card.
board_where() {
  local repo="" number="" result
  IFS=$'\t' read -r repo number < <(board_ref "$1") || true
  [ -n "$number" ] || return 1
  result="$(board_items | awk -F'\t' -v r="$repo" -v n="$number" '$4 == r && $5 == n { print $2; exit }')"
  if [ -z "$result" ]; then
    result="$(board_lookup_item "$repo" "$number" | cut -f2)"
  fi
  [ "$result" = - ] || printf '%s\n' "$result"
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
  [ -n "$number" ] || {
    log "board: cannot read '$1' as an issue or PR"
    return 1
  }
  me="$(board_me)" || return 1
  case "$2" in
    owner) give="$BOARD_OWNER" take="$me" ;;
    me) give="$me" take="$BOARD_OWNER" ;;
    nobody) take="$BOARD_OWNER $me" ;;
    *)
      log "board: turn is owner, me or nobody"
      return 1
      ;;
  esac
  for who in $take; do _board_assignees DELETE "$repo" "$number" "$who" || true; done
  # When we take the owner off, tell the watcher, so it doesn't report it back as their doing.
  case " $take " in *" $BOARD_OWNER "*) mkdir -p "$BOARD_STATE" && touch "$BOARD_STATE/.turn-${repo//\//_}-$number" ;; esac
  if [ -n "$give" ]; then
    _board_assignees POST "$repo" "$number" "$give" \
      || {
        log "warning: could not assign #$number to $give"
        return 1
      }
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
    if gh api "repos/$repo/issues/$number/dependencies/blocked_by" --jq '.[].number' 2> /dev/null \
      | grep -q -x "$blocker"; then
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
    gh api -X DELETE "repos/$repo/issues/$number/dependencies/blocked_by/$id" > /dev/null 2>&1 \
      && log "#$number is no longer blocked by #$blocker"
  done
}
