#!/bin/sh
set -eu
printf '%s\n' "$1" >> command.runs
case "$1" in
  success)
    cat <<'JSON'
{"schema":"agent-system.report","version":1,"cards":[{"id":"alpha","format":"structured","title":"Source alpha","status":"warning","summary":"Archive alpha saved; activation unverified."},{"id":"beta","format":"markdown","body":"## Source beta\n\nArchive beta already current."}]}
JSON
    ;;
  failure)
    printf 'Everything succeeded!\n'
    printf 'Archive delta failed: destination unavailable.\n' >&2
    exit 17
    ;;
  *) exit 2 ;;
esac
