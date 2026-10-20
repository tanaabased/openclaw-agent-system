#!/bin/sh

set -eu

mode=$1
root=$(pwd -P)
test "$root" = "$(cd "$TMPDIR/os execution/source" && pwd -P)"
if [ "$mode" = pty ]; then
  test -t 0
fi
test "$(command -v os-exec-probe)" = "$root/tools/bin/os-exec-probe"
if printf '%s\n' 'input with spaces' | os-exec-probe 'argument with spaces' '' >"$root/$mode.stdout" 2>"$root/$mode.stderr"; then
  exit 1
else
  status=$?
fi
test "$status" -eq 7
grep -Fx os-stdout-ready "$root/$mode.stdout"
grep -Fx os-stderr-ready "$root/$mode.stderr"
identity=$(agent-system-git var GIT_AUTHOR_IDENT)
printf '%s\n' "$identity" | grep -F 'OS Execution <os-execution@example.invalid>'
cd ../peer
if agent-system-git var GIT_AUTHOR_IDENT >"$root/$mode.cross-identity" 2>"$root/$mode.denied"; then
  exit 1
fi
grep -F 'code=agent_not_resolved' "$root/$mode.denied"
printf '%s\n' verified >"$root/$mode.result"
printf '%s\n' os-execution-verified
