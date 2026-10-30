#!/bin/sh
set -eu
printf '%s\n' "$1" >> command.runs
case "$1" in
  success)
    printf 'Archive alpha saved.\n'
    ;;
  failure)
    printf 'Everything succeeded!\n'
    printf 'Archive delta failed: destination unavailable.\n' >&2
    exit 17
    ;;
  *) exit 2 ;;
esac
