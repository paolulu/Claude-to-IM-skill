#!/usr/bin/env bash
set -euo pipefail
CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Multi-instance support ──
# Parse --instance <name> or positional instance name for start/stop/status/logs.
# CTI_INSTANCE env var can also be used directly.

CTI_INSTANCE="${CTI_INSTANCE:-}"

# Parse --instance flag if present (must come before subcommand)
ARGS=("$@")
PARSED_ARGS=()
i=0
while [ $i -lt ${#ARGS[@]} ]; do
  case "${ARGS[$i]}" in
    --instance)
      i=$((i + 1))
      CTI_INSTANCE="${ARGS[$i]:-}"
      ;;
    --instance=*)
      CTI_INSTANCE="${ARGS[$i]#--instance=}"
      ;;
    *)
      PARSED_ARGS+=("${ARGS[$i]}")
      ;;
  esac
  i=$((i + 1))
done
set -- "${PARSED_ARGS[@]+"${PARSED_ARGS[@]}"}"

# Resolve INSTANCE_HOME based on CTI_INSTANCE
resolve_instance_home() {
  local name="${1:-}"
  if [ -z "$name" ] || [ "$name" = "default" ]; then
    echo "$CTI_HOME"
  else
    echo "$CTI_HOME/instances/$name"
  fi
}

INSTANCE_HOME="$(resolve_instance_home "$CTI_INSTANCE")"
export CTI_INSTANCE

# Instance-scoped paths
PID_FILE="$INSTANCE_HOME/runtime/bridge.pid"
STATUS_FILE="$INSTANCE_HOME/runtime/status.json"
LOG_FILE="$INSTANCE_HOME/logs/bridge.log"

instance_label() {
  if [ -n "$CTI_INSTANCE" ] && [ "$CTI_INSTANCE" != "default" ]; then
    echo " [$CTI_INSTANCE]"
  else
    echo ""
  fi
}

# List all known instances (scan instances/ dir + check default)
list_all_instances() {
  local instances=()
  # Default instance
  if [ -f "$CTI_HOME/config.env" ]; then
    instances+=("default")
  fi
  # Named instances
  if [ -d "$CTI_HOME/instances" ]; then
    for dir in "$CTI_HOME/instances"/*/; do
      [ -d "$dir" ] || continue
      local name
      name=$(basename "$dir")
      if [ -f "$dir/config.env" ]; then
        instances+=("$name")
      fi
    done
  fi
  echo "${instances[@]+"${instances[@]}"}"
}

# ── Common helpers ──

ensure_dirs() { mkdir -p "$INSTANCE_HOME"/{data,logs,runtime,data/messages}; }

ensure_built() {
  local need_build=0
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

# Clean environment for subprocess isolation.
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$INSTANCE_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  local mode="${CTI_ENV_ISOLATION:-strict}"
  if [ "$mode" = "strict" ]; then
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        if [ "${CTI_ANTHROPIC_PASSTHROUGH:-}" != "true" ]; then
          while IFS='=' read -r name _; do
            case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
          done < <(env)
        fi
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      auto)
        if [ "${CTI_ANTHROPIC_PASSTHROUGH:-}" != "true" ]; then
          while IFS='=' read -r name _; do
            case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
          done < <(env)
        fi
        ;;
    esac
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\"${CTI_INSTANCE:+ --instance $CTI_INSTANCE}"
  echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\"${CTI_INSTANCE:+ --instance $CTI_INSTANCE} logs 100"
  echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
}

# ── Load platform-specific supervisor ──

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows detected via Git Bash / MSYS2 / Cygwin — delegate to PowerShell
    echo "Windows detected. Delegating to supervisor-windows.ps1..."
    powershell.exe -ExecutionPolicy Bypass -File "$SKILL_DIR/scripts/supervisor-windows.ps1" "$@"
    exit $?
    ;;
  *)
    # shellcheck source=supervisor-linux.sh
    source "$SKILL_DIR/scripts/supervisor-linux.sh"
    ;;
esac

# ── Commands ──

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built

    # Check if already running (supervisor-aware: launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      EXISTING_PID=$(read_pid)
      echo "Bridge$(instance_label) already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi

    # Source config.env BEFORE clean_env so that CTI_ANTHROPIC_PASSTHROUGH
    # and other CTI_* flags are available when clean_env checks them.
    [ -f "$INSTANCE_HOME/config.env" ] && set -a && source "$INSTANCE_HOME/config.env" && set +a

    clean_env
    echo "Starting bridge$(instance_label)..."
    supervisor_start

    # Poll for up to 10 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 10); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge$(instance_label) started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge$(instance_label)."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    if supervisor_is_managed; then
      echo "Stopping bridge$(instance_label)..."
      supervisor_stop
      echo "Bridge$(instance_label) stopped"
    else
      PID=$(read_pid)
      if [ -z "$PID" ]; then echo "No bridge$(instance_label) running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge$(instance_label) stopped"
      else
        echo "Bridge$(instance_label) was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  status)
    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_pid)
      echo "Bridge$(instance_label) process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        echo "Bridge$(instance_label) status: running"
      else
        echo "Bridge$(instance_label) status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge$(instance_label) is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
      show_last_exit_reason
    fi
    ;;

  status-all)
    INSTANCES=$(list_all_instances)
    if [ -z "$INSTANCES" ]; then
      echo "No instances found."
      exit 0
    fi
    for inst in $INSTANCES; do
      echo "── Instance: $inst ──"
      CTI_INSTANCE="$inst" bash "$0" --instance "$inst" status 2>/dev/null || true
      echo ""
    done
    ;;

  start-all)
    INSTANCES=$(list_all_instances)
    if [ -z "$INSTANCES" ]; then
      echo "No instances found."
      exit 0
    fi
    for inst in $INSTANCES; do
      echo "── Starting instance: $inst ──"
      bash "$0" --instance "$inst" start || true
      echo ""
    done
    ;;

  stop-all)
    INSTANCES=$(list_all_instances)
    if [ -z "$INSTANCES" ]; then
      echo "No instances found."
      exit 0
    fi
    for inst in $INSTANCES; do
      echo "── Stopping instance: $inst ──"
      bash "$0" --instance "$inst" stop || true
      echo ""
    done
    ;;

  logs)
    N="${2:-50}"
    tail -n "$N" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["\\x27]?\s*[:=]\s*["\\x27]?)[^ "]+/\1\2*****/gi'
    ;;

  *)
    echo "Usage: daemon.sh [--instance <name>] {start|stop|status|logs [N]|start-all|stop-all|status-all}"
    ;;
esac
