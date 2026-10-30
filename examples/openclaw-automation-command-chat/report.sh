#!/bin/sh
set -eu
printf '%s\n' "$1" >> command.runs
case "$1" in
  markdown)
    printf '# Archive complete\n\n- Saved archive alpha\n\n| files | result |\n| --- | --- |\n| 3 | saved |\n'
    ;;
  json)
    printf '{"archive":"bravo","files":4,"status":"saved"}\n'
    ;;
  text)
    printf 'Archive charlie saved with 5 files. No further changes were needed.\n'
    ;;
  failure)
    printf 'Everything succeeded!\n'
    printf 'Archive delta failed: destination unavailable.\n' >&2
    exit 17
    ;;
  *) exit 2 ;;
esac
