#!/bin/sh
printf '%s\n' 'stdout-fixture-marker'
printf '%s\n' 'stderr-fixture-marker' >&2
exit 17
