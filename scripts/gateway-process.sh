#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
pid_path="$TMPDIR/gateway.pid"
log_path="$TMPDIR/gateway.log"
call_log_path="$TMPDIR/gateway-call.log"

usage() {
  echo "Usage: gateway-process.sh <start|wait|restart|stop|diagnostics> [timeout-seconds]" >&2
}

require_positive_timeout() {
  local timeout_seconds="$1"
  if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    echo "Timeout must be a positive integer: $timeout_seconds" >&2
    exit 2
  fi
}

tail_diagnostics() {
  if [[ -f "$call_log_path" ]]; then
    tail -n 40 "$call_log_path" >&2
  fi
  if [[ -f "$log_path" ]]; then
    tail -n 120 "$log_path" >&2
  fi
}

read_gateway_pid() {
  if [[ ! -f "$pid_path" ]]; then
    echo "Gateway PID file is missing: $pid_path" >&2
    return 1
  fi
  gateway_pid="$(cat "$pid_path")"
  if [[ ! "$gateway_pid" =~ ^[0-9]+$ ]]; then
    echo "Gateway PID is invalid: $gateway_pid" >&2
    return 1
  fi
}

gateway_is_running() {
  read_gateway_pid && kill -0 "$gateway_pid" 2>/dev/null
}

wait_for_gateway() {
  local timeout_seconds="${1:-90}"
  local deadline=$((SECONDS + timeout_seconds))
  read_gateway_pid
  until openclaw gateway call agents.list --json --timeout 3000 > /dev/null 2> "$call_log_path"; do
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      echo "Gateway exited before becoming ready." >&2
      tail_diagnostics
      return 1
    fi
    if ((SECONDS >= deadline)); then
      echo "Gateway did not become ready within $timeout_seconds seconds." >&2
      tail_diagnostics
      return 1
    fi
    sleep 1
  done
}

start_gateway() {
  local timeout_seconds="${1:-90}"
  if [[ -f "$pid_path" ]]; then
    if gateway_is_running; then
      echo "Gateway is already running: $gateway_pid" >&2
      return 1
    fi
    rm -f "$pid_path"
  fi

  (
    exec openclaw gateway run --verbose >> "$log_path" 2>&1 < /dev/null
  ) &
  gateway_pid="$!"
  printf '%s\n' "$gateway_pid" > "$pid_path"
  wait_for_gateway "$timeout_seconds"
}

stop_gateway() {
  local timeout_seconds="${1:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  if [[ ! -f "$pid_path" ]]; then
    return 0
  fi
  read_gateway_pid
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    rm -f "$pid_path"
    return 0
  fi
  if ! kill -TERM "$gateway_pid" 2>/dev/null; then
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      rm -f "$pid_path"
      return 0
    fi
    echo "Gateway could not be asked to stop: $gateway_pid" >&2
    tail_diagnostics
    return 1
  fi
  while kill -0 "$gateway_pid" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      echo "Gateway did not stop within $timeout_seconds seconds." >&2
      tail_diagnostics
      return 1
    fi
    sleep 1
  done
  rm -f "$pid_path"
}

restart_gateway() {
  local timeout_seconds="${1:-90}"
  stop_gateway "$timeout_seconds"
  start_gateway "$timeout_seconds"
}

case "$action" in
  start)
    timeout_seconds="${2:-90}"
    require_positive_timeout "$timeout_seconds"
    start_gateway "$timeout_seconds"
    ;;
  wait)
    timeout_seconds="${2:-90}"
    require_positive_timeout "$timeout_seconds"
    wait_for_gateway "$timeout_seconds"
    ;;
  restart)
    timeout_seconds="${2:-90}"
    require_positive_timeout "$timeout_seconds"
    restart_gateway "$timeout_seconds"
    ;;
  stop)
    timeout_seconds="${2:-30}"
    require_positive_timeout "$timeout_seconds"
    stop_gateway "$timeout_seconds"
    ;;
  diagnostics)
    tail_diagnostics
    ;;
  *)
    usage
    exit 2
    ;;
esac
