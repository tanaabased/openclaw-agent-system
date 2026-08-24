# GitHub Issue Work Implementation Scenario

This macOS-only scenario proves the `issue` + `work` + `implementation` turn.
Its setup establishes a real planned assignment; its assertions cover only the
exact repository change, lifecycle-normalized commit, and managed branch push.

The scenario creates one disposable issue in `tanaabased/big-test-bucket` and
removes its pull request, branch, generated SSH key, and issue during cleanup.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --needs-ssh-key \
  --yolo

# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should prepare notification and approved actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/actor-agent.yaml" "$TMPDIR/agent-system-notification-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/notification-agent-login"

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should install the route and establish the first baseline synchronously
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-implementation-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should prepare one planned issue for implementation
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "add implementation fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create implementation-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: implementation fixture ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 420
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_path="$(jq -re 'select(length == 1) | .[0].path' <<< "$worktrees")"
worktree_branch="$(jq -re 'select(length == 1) | .[0].branch' <<< "$worktrees")"
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- rev-parse HEAD > "$TMPDIR/implementation-base-sha"
printf '%s' "$worktree_branch" > "$TMPDIR/approved-worktree-branch"
```

## Testing

```bash
# should implement the exact assignment fixture
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 420
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
worktree_path="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list | jq -re 'select(length == 1) | .[0].path')"
fixture_path="$worktree_path/implementation-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
expected_fixture="$TMPDIR/expected-implementation-fixture"
printf 'implementation fixture ready.\n' > "$expected_fixture"
cmp -s "$expected_fixture" "$fixture_path"
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"

# should create one issue referenced commit as tanaabot
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
worktree_path="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list | jq -re 'select(length == 1) | .[0].path')"
cd "$worktree_path"
base_sha="$(cat "$TMPDIR/implementation-base-sha")"
commit_count="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- rev-list --count "$base_sha..HEAD")"
test "$commit_count" -eq 1
author="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- log -1 --format='%an <%ae>')"
test "$author" = 'Tanaabot <tanaabot@tanaab.dev>'
subject="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- log -1 --format=%s)"
[[ "$subject" == "#$issue_number: "* ]]

# should push the managed branch at the exact local commit
cd "$TMPDIR/agent-system-notifications"
worktree_path="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list | jq -re 'select(length == 1) | .[0].path')"
worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
cd "$worktree_path"
head_sha="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- rev-parse HEAD)"
remote_line="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- ls-remote --heads origin "refs/heads/$worktree_branch")"
remote_sha="$(printf '%s\n' "$remote_line" | cut -f1)"
test -n "$remote_sha"
test "$remote_sha" = "$head_sha"
```

## Cleanup

```bash
# should remove only the pushed scenario branch and pull request
if test -f "$TMPDIR/approved-worktree-branch"; then
  cd "$TMPDIR/agent-system-notifications"
  worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
  pull_request_number="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr list --repo tanaabased/big-test-bucket --head "$worktree_branch" --state open --json number --jq '.[0].number // empty')"
  if test -n "$pull_request_number"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr close "$pull_request_number" --repo tanaabased/big-test-bucket
  fi
  if OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --silent --method GET "/repos/tanaabased/big-test-bucket/git/ref/heads/$worktree_branch"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/repos/tanaabased/big-test-bucket/git/refs/heads/$worktree_branch"
  fi
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method GET "/repos/tanaabased/big-test-bucket/git/matching-refs/heads/$worktree_branch" --jq length)"
  test "$remaining" -eq 0
fi

# should remove only the generated tanaabot public key
if test -f "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
  test -z "$remaining"
fi

# should close the remote issue fixture
if test -f "$TMPDIR/approved-issue-number"; then
  cd "$TMPDIR/agent-system-notification-actor"
  issue_number="$(cat "$TMPDIR/approved-issue-number")"
  agent_login="$(cat "$TMPDIR/notification-agent-login")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$issue_number" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$issue_number" --repo tanaabased/big-test-bucket
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```
