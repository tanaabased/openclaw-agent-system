#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
pid_path="$TMPDIR/gateway.pid"
log_path="$TMPDIR/gateway.log"
call_log_path="$TMPDIR/gateway-call.log"

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

stop_gateway() {
  local timeout_seconds="${1:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  if [[ ! -f "$pid_path" ]]; then
    return 0
  fi
  read_gateway_pid
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    return 0
  fi
  if ! kill -TERM "$gateway_pid" 2>/dev/null; then
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
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
}

case "$action" in
  wait)
    wait_for_gateway "${2:-90}"
    ;;
  stop)
    stop_gateway "${2:-30}"
    ;;
  *)
    echo "Usage: gateway-process.sh <wait|stop> [timeout-seconds]" >&2
    exit 2
    ;;
esac
