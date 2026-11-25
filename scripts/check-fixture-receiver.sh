#!/usr/bin/env bash
# Compare the runner credential with the managed request after a hosted scenario fails.
curl --disable --silent --show-error --max-time 10 --output /dev/null \
  --write-out 'runner receiver GET /user HTTP %{http_code}\n' \
  --header "Authorization: Bearer ${GH_TOKEN_TANAABOT:?}" https://api.github.com/user
