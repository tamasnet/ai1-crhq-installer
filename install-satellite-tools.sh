#!/usr/bin/env bash
# install_entry — symlink ai1-satellite-tools CLIs into ~/.local/bin and schedule heartbeat-actions.
# Path defaults match scripts/lib/context.mjs.

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────
readonly PKG_NAME="ai1-satellite-tools"
readonly SCRIPTS="install.mjs sync.mjs remote.mjs action.mjs polaris.mjs drift.mjs diff.mjs"
readonly HEARTBEAT_SCRIPT="heartbeat-actions.sh"
readonly CRON_TAG="# ai1-satellite-tools: heartbeat-actions"
readonly CRON_SCHEDULE="*/15 * * * *"

# ── state (set by parse_args / resolve_paths) ────────────────────────────────
MODE=install
DRY_RUN=false
SKIP_EXTRA=false
SKILLS_BASE=
BIN_DIR=
SCRIPTS_DIR=
HEARTBEAT_PATH=

# ── helpers ──────────────────────────────────────────────────────────────────
log() {
  printf '[%s-entry] %s\n' "$PKG_NAME" "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

dry() {
  [[ "$DRY_RUN" == true ]]
}

run() {
  if dry; then
    log "[dry-run] would run: $*"
  else
    log "run: $*"
    "$@"
  fi
}

# Mirror resolveSkillsBase() in context.mjs
resolve_skills_base() {
  if [[ -n "${SKILLS_BASE_DIR:-}" ]]; then
    printf '%s' "$SKILLS_BASE_DIR"
  elif [[ -n "${CRHQ_BASE_DIR:-}" ]]; then
    printf '%s/user-skills' "$CRHQ_BASE_DIR"
  else
    printf '%s' '/opt/projects/crhq-satellite/user-skills'
  fi
}

resolve_paths() {
  SKILLS_BASE="$(resolve_skills_base)"
  BIN_DIR="${HOME}/.local/bin"
  SCRIPTS_DIR="${SKILLS_BASE}/${PKG_NAME}/scripts"
  HEARTBEAT_PATH="${SCRIPTS_DIR}/${HEARTBEAT_SCRIPT}"
}

cron_line() {
  printf '%s flock -n %q %q %s' "$CRON_SCHEDULE" "$HEARTBEAT_PATH" "$HEARTBEAT_PATH" "$CRON_TAG"
}

cron_installed() {
  crontab -l 2>/dev/null | grep -Fq "$CRON_TAG"
}

symlinks_present() {
  for each in $SCRIPTS; do
    [[ -L "${BIN_DIR}/${each}" ]] || return 1
  done
}

heartbeat_script_present() {
  [[ -x "$HEARTBEAT_PATH" ]]
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --uninstall)  MODE=uninstall ;;
      --status)     MODE=status ;;
      --dry-run)    DRY_RUN=true ;;
      --skip-extra) SKIP_EXTRA=true ;;
    esac
  done
}

install_cron() {
  if cron_installed; then
    log "cron already present"
    return 0
  fi

  local line tmp
  line="$(cron_line)"

  if dry; then
    log "[dry-run] would add crontab: $line"
    return 0
  fi

  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -Fv "$CRON_TAG" >"$tmp" || true
  printf '%s\n' "$line" >>"$tmp"
  crontab "$tmp"
  rm -f "$tmp"
  log "cron installed"
}

uninstall_cron() {
  if ! cron_installed; then
    log "cron not present"
    return 0
  fi

  if dry; then
    log "[dry-run] would remove crontab entries tagged $CRON_TAG"
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -Fv "$CRON_TAG" >"$tmp" || true
  crontab "$tmp"
  rm -f "$tmp"
  log "cron removed"
}

# ── mode handlers ────────────────────────────────────────────────────────────
handle_status() {
  local ok=true

  if symlinks_present; then
    log "status: symlinks ok"
  else
    log "status: symlinks missing"
    ok=false
  fi

  if cron_installed; then
    log "status: cron ok"
  else
    log "status: cron missing"
    ok=false
  fi

  if heartbeat_script_present; then
    log "status: heartbeat script ok"
  else
    log "status: heartbeat script missing or not executable"
    ok=false
  fi

  if [[ "$ok" == true ]]; then
    log "status: ok"
    return 0
  fi

  return 1
}

handle_install() {
  if ! heartbeat_script_present; then
    die "heartbeat script not found or not executable: $HEARTBEAT_PATH"
  fi

  run mkdir -p "$BIN_DIR"

  for each in $SCRIPTS; do
    run ln -sf "${SCRIPTS_DIR}/${each}" "${BIN_DIR}/${each}"
  done

  install_cron

  log "install complete"
}

handle_uninstall() {
  for each in $SCRIPTS; do
    run rm -f "${BIN_DIR}/${each}"
  done

  uninstall_cron

  log "uninstall complete"
}

dispatch() {
  log "mode=$MODE dry_run=$DRY_RUN skills_base=$SKILLS_BASE"

  if [[ "$SKIP_EXTRA" == true ]]; then
    log "--skip-extra set; skipping package-specific steps"
    return 0
  fi

  case "$MODE" in
    status)    handle_status ;;
    uninstall) handle_uninstall ;;
    install)   handle_install ;;
    *)         die "unknown mode: $MODE" ;;
  esac
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  resolve_paths
  dispatch
}

main "$@"
