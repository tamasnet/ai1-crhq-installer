#!/usr/bin/env bash
# Cron hook: jittered hub heartbeat, then process any queued advisory actions.
# Optional first argument: sleep offset in seconds (skips machine-id jitter).
# Lives alongside remote.mjs / action.mjs under SKILLS_BASE_DIR/ai1-satellite-tools/scripts/.

set -euo pipefail

readonly PKG_NAME="ai1"

log() {
  printf '[%s] %s\n' "$PKG_NAME" "$*" >&2
}

script_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

get_checkin_offset() {
  local mid hash hex dec

  if [[ -r /etc/machine-id ]]; then
    mid=$(< /etc/machine-id)
  elif [[ -r /var/lib/dbus/machine-id ]]; then
    mid=$(< /var/lib/dbus/machine-id)
  elif [[ -r /sys/class/dmi/id/product_uuid ]]; then
    mid=$(< /sys/class/dmi/id/product_uuid)
  else
    mid="$(hostname)-$(uname -n)"
  fi

  hash=$(printf '%s' "${PKG_NAME}:${mid}" | sha256sum | awk '{print $1}')
  hex=${hash:0:8}
  dec=$((16#$hex))

  echo $((dec % 840))
}

resolve_offset() {
  if [[ $# -eq 0 ]]; then
    get_checkin_offset
    return
  fi

  if [[ $# -ne 1 ]]; then
    log "error: expected at most one offset argument"
    exit 1
  fi

  if [[ "$1" =~ ^[0-9]+$ ]]; then
    printf '%s' "$1"
    return
  fi

  log "error: offset must be a non-negative integer"
  exit 1
}

actions_file() {
  local remote_dir="${REMOTE_BASE_DIR:-$HOME/remote}"
  printf '%s/actions.json' "$remote_dir"
}

actions_pending() {
  local file
  file="$(actions_file)"
  [[ -f "$file" ]] || return 1
  [[ "$(jq -r '.actions | length' "$file")" -gt 0 ]]
}

main() {
  local offset dir node remote action

  dir="$(script_dir)"
  node="$(command -v node || true)"
  [[ -n "$node" ]] || { log "error: node not found on PATH"; exit 1; }

  remote="${dir}/remote.mjs"
  action="${dir}/action.mjs"
  [[ -f "$remote" ]] || { log "error: missing ${remote}"; exit 1; }
  [[ -f "$action" ]] || { log "error: missing ${action}"; exit 1; }

  offset="$(resolve_offset "$@")"
  if [[ $# -eq 0 ]]; then
    log "sleeping ${offset}s (check-in jitter)"
  else
    log "sleeping ${offset}s (explicit offset)"
  fi
  sleep "$offset"

  log "remote heartbeat"
  "$node" "$remote" heartbeat

  if actions_pending; then
    log "processing queued actions"
    "$node" "$action"
  else
    log "no queued actions"
  fi
}

main "$@"
