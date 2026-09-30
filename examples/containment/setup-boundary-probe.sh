#!/bin/sh

set -eu

export OPENCLAW_LOG_LEVEL=error

probe="$TMPDIR/agent-system-setup-boundary-$1"

denied() {
  if "$@" > "$probe.stdout" 2> "$probe.stderr"; then
    printf '%s\n' 'an agent descendant executed an operator command' >&2
    exit 1
  fi
  test ! -s "$probe.stdout"
  grep -F 'operator commands are unavailable to agent or setup descendants' "$probe.stderr"
}

denied env CI=1 NONINTERACTIVE=on openclaw as install --non-interactive --json
test ! -e "$TMPDIR/agent-system-forbidden-setup"
printf '%s\n' verified > "$probe.txt"
