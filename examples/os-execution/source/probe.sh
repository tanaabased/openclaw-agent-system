#!/bin/sh

set -eu

mode=$1
started=$(date +%s)
stage() {
  printf 'os-execution mode=%s stage=%s elapsed=%ss\n' "$mode" "$1" "$(($(date +%s) - started))"
}
stage native-io
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
if [ "$mode" = pipe ]; then
  test -z "${PROBE_SELECTED+x}"
  declared-probe declared | grep -Fx declared-child-ready
fi
stage source-identity
identity=$(agent-system-git var GIT_AUTHOR_IDENT)
printf '%s\n' "$identity" | grep -F 'OS Execution <os-execution@example.invalid>'
stage unavailable-context-diagnostic
if AGENT_SYSTEM_EXEC_AUTHORITY=denied AGENT_SYSTEM_EXEC_CAPABILITY=denied:context-unresolved agent-system-git var GIT_AUTHOR_IDENT >"$root/$mode.unresolved-identity" 2>"$root/$mode.unresolved"; then
  exit 1
fi
test ! -s "$root/$mode.unresolved-identity"
grep -F 'reason=command-context-context-unresolved' "$root/$mode.unresolved"
grep -F 'code=agent_not_resolved' "$root/$mode.unresolved"
stage cross-agent-rejection
cd ../peer
if agent-system-git var GIT_AUTHOR_IDENT >"$root/$mode.cross-identity" 2>"$root/$mode.denied"; then
  exit 1
fi
grep -F 'code=agent_not_resolved' "$root/$mode.denied"
stage complete
printf '%s\n' verified >"$root/$mode.result"
printf '%s\n' os-execution-verified
