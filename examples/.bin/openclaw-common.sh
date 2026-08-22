# shellcheck shell=bash

value_enabled() {
  case "${1:-}" in
    '' | 0 | false | FALSE | False | no | NO | No | off | OFF | Off)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

if [[ -n "${OPENCLAW_DEBUG:-}" ]]; then
  debug_value="$OPENCLAW_DEBUG"
elif [[ "${OPENCLAW_LOG_LEVEL:-}" == 'debug' ]]; then
  debug_value=1
elif [[ -n "${DEBUG+x}" ]]; then
  debug_value="$DEBUG"
else
  debug_value="${RUNNER_DEBUG:-}"
fi

apply_debug_environment() {
  if ! value_enabled "$debug_value"; then
    return
  fi

  export OPENCLAW_DEBUG_CODE_MODE="${OPENCLAW_DEBUG_CODE_MODE:-1}"
  export OPENCLAW_DEBUG_MODEL_PAYLOAD="${OPENCLAW_DEBUG_MODEL_PAYLOAD:-tools}"
  export OPENCLAW_DEBUG_MODEL_TRANSPORT="${OPENCLAW_DEBUG_MODEL_TRANSPORT:-1}"
  export OPENCLAW_DEBUG_SSE="${OPENCLAW_DEBUG_SSE:-events}"
  export OPENCLAW_LOG_LEVEL="${OPENCLAW_LOG_LEVEL:-debug}"
  export OPENCLAW_PLUGIN_LIFECYCLE_TRACE="${OPENCLAW_PLUGIN_LIFECYCLE_TRACE:-1}"
}

apply_debug_environment

if { [[ -t 1 ]] || [[ -t 2 ]] || value_enabled "${FORCE_COLOR:-}"; } && [[ -z "${NO_COLOR-}" ]]; then
  escape() { printf '\033[%sm' "$1"; }
else
  escape() { :; }
fi

# shellcheck disable=SC2034
tty_bold="$(escape '1;39')"
tty_dim="$(escape '2;39')"
tty_red="$(escape '1;31')"
tty_reset="$(escape 0)"
# shellcheck disable=SC2034
tty_tp="$(escape '38;2;0;200;138')"

enable_debug() {
  debug_value=1
  apply_debug_environment
}

debug() {
  if value_enabled "$debug_value"; then
    printf '%sdebug%s: %s\n' "$tty_dim" "$tty_reset" "$*" >&2
  fi
}

error_message() {
  printf '%serror%s: %s\n' "$tty_red" "$tty_reset" "$1" >&2
}

error() {
  local message="$1"
  local exit_code="${2:-1}"

  error_message "$message"
  exit "$exit_code"
}

require_positive_integer() {
  local label="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    error "$label must be a positive integer: $value" 2
  fi
}
