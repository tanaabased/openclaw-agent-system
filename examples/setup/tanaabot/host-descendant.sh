#!/bin/sh

set -eu

managed_launcher=$(dirname "$(command -v git)")/agent-system-tool
mkdir -p "$TMPDIR/setup-host-descendant"
cd "$TMPDIR/setup-host-descendant"

# host git permits configuration arguments that managed git rejects.
git -c user.name=host-fixture -c user.email=host@example.invalid var GIT_AUTHOR_IDENT |
  grep -F 'host-fixture <host@example.invalid>'
gh --version | grep -F 'gh version'

# host git aliases expose the actual post-handoff environment without a network call.
# shellcheck disable=SC2016
git -c 'alias.check-host=!test -z "$AGENT_SYSTEM_EXEC_CAPABILITY" && test -z "$AGENT_SYSTEM_EXEC_AUTHORITY" && test -z "$AGENT_SYSTEM_TOOL_LAUNCHER_DIR" && test -z "$GH_TOKEN" && test -z "$GH_CONFIG_DIR" && test -z "$GIT_AUTHOR_NAME" && test -z "$SSH_AUTH_SOCK"' check-host

if "$managed_launcher" git --version; then exit 1; fi
if "$managed_launcher" gh --version; then exit 1; fi
if "$managed_launcher" worktree list; then exit 1; fi

if AGENT_SYSTEM_EXEC_CAPABILITY=forged git --version; then exit 1; fi
if AGENT_SYSTEM_EXEC_CAPABILITY=forged gh --version; then exit 1; fi

printf 'verified\n' > "$TMPDIR/setup-host-descendant/verified"
