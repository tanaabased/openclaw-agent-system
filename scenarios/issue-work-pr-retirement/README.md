# GitHub Issue Work PR Retirement Scenario

This GitHub Actions-only scenario proves merge-driven retirement for an
`issue` + `work` lifecycle. Its setup establishes a real planned assignment,
continues the same lifecycle through one deterministic implementation and
delivery pull request, then retargets that pull request to a disposable
non-default base branch before an approved actor merges it. The assertions prove
that the issue remains open while the pull-request merge retires the issue-owned
session, archives it, and removes only its clean managed worktree. The same
lifecycle contract runs against the deterministic mock provider on pull requests
and the live provider through workflow dispatch.

The scenario creates one disposable issue, pull request, head branch, and
temporary base branch in `tanaabased/big-test-bucket`, then removes every
remaining remote fixture, generated SSH key, and issue during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario pr-retirement \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"
```

```bash
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
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-pull-request-retirement-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should prepare one planned issue for pull request retirement
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "retire merged pull request fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create pull-request-retirement-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: pull request retirement fixture ready." \
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
worktree_branch="$(jq -re 'select(length == 1) | .[0].branch' <<< "$worktrees")"
printf '%s' "$worktree_branch" > "$TMPDIR/approved-worktree-branch"

# should complete implementation before pull request reconciliation
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
```

## Testing

```bash
# should link one normalized delivery pull request to the issue-owned session
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr list --repo tanaabased/big-test-bucket --head "$worktree_branch" --state open --json assignees,author,baseRefName,body,headRefName,number,state,title,url --jq 'select(length == 1) | .[0]')"
jq -e --arg branch "$worktree_branch" --arg title "retire merged pull request fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" --argjson issue "$issue_number" '.state == "OPEN" and .baseRefName == "main" and .headRefName == $branch and .title == $title and (.body | contains("Closes #" + ($issue | tostring))) and .author.login == "tanaabot" and ([.assignees[].login] | index("emoriwan") != null)' <<< "$pull_request"
jq -r '.number' <<< "$pull_request" > "$TMPDIR/approved-pull-request-number"
handoff_count="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:pull-request-handoff")))] | length')"
test "$handoff_count" -eq 1
```

```bash
# should retarget the delivery pull request to one disposable non-default base
cd "$TMPDIR/agent-system-notification-actor"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
retirement_base="agent-system-pr-retirement-base-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS"
printf '%s' "$retirement_base" > "$TMPDIR/retirement-base-branch"
base_sha="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api "/repos/tanaabased/big-test-bucket/git/ref/heads/main" --jq .object.sha)"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method POST /repos/tanaabased/big-test-bucket/git/refs -f "ref=refs/heads/$retirement_base" -f "sha=$base_sha" --jq .ref
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr edit "$pull_request_number" --repo tanaabased/big-test-bucket --base "$retirement_base"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json baseRefName --jq .baseRefName | grep -Fx "$retirement_base"
```

```bash
# should wait until github reports the retargeted pull request as mergeable
cd "$TMPDIR/agent-system-notification-actor"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
mergeable=''
for attempt in $(seq 1 30); do
  mergeable="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json mergeable --jq .mergeable)"
  if [[ "$mergeable" == 'MERGEABLE' ]]; then
    break
  fi
  sleep 1
done
test "$mergeable" = MERGEABLE
```

```bash
# should merge as emoriwan without closing the issue
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
retirement_base="$(cat "$TMPDIR/retirement-base-branch")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr merge "$pull_request_number" --repo tanaabased/big-test-bucket --merge
merged_pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json baseRefName,mergedAt,mergedBy,state)"
jq -e --arg base "$retirement_base" '.state == "MERGED" and .mergedAt != null and .mergedBy.login == "emoriwan" and .baseRefName == $base' <<< "$merged_pull_request"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue view "$issue_number" --repo tanaabased/big-test-bucket --json state --jq .state | grep -Fx OPEN
```

```bash
# should checkpoint logical retirement from the merged delivery pull request
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and .code == "github-notification-retired" and (.observation.items[0] | .disposition == "retired" and .reasonCode == "pull-request-merged" and .stage == "retired")'
```

```bash
# should independently archive the session and remove only its clean worktree
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and (.observation.items[0] | .cleanup.status == "completed" and .cleanup.session == "archived" and .cleanup.worktree == "removed")'
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
test "$(jq length <<< "$worktrees")" -eq 0
```

```bash
# should expose bounded evidence for the selected notification model
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario pr-retirement \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-pr-retirement/expected-evidence.json"
```

## Cleanup

```bash
# should remove only the generated tanaabot public key
if test -f "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
  test -z "$remaining"
fi
```

```bash
# should remove only the delivery pull request head branch when it remains
if test -f "$TMPDIR/approved-pull-request-number"; then
  cd "$TMPDIR/agent-system-notifications"
  pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
  pull_request_state="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json state --jq .state)"
  if [[ "$pull_request_state" == 'OPEN' ]]; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr close "$pull_request_number" --repo tanaabased/big-test-bucket
  fi
fi
if test -f "$TMPDIR/approved-worktree-branch"; then
  cd "$TMPDIR/agent-system-notifications"
  worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
  if OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --silent --method GET "/repos/tanaabased/big-test-bucket/git/ref/heads/$worktree_branch"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/repos/tanaabased/big-test-bucket/git/refs/heads/$worktree_branch"
  fi
fi
```

```bash
# should remove only the disposable non-default base branch
if test -f "$TMPDIR/retirement-base-branch"; then
  cd "$TMPDIR/agent-system-notification-actor"
  retirement_base="$(cat "$TMPDIR/retirement-base-branch")"
  if OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --silent --method GET "/repos/tanaabased/big-test-bucket/git/ref/heads/$retirement_base"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method DELETE "/repos/tanaabased/big-test-bucket/git/refs/heads/$retirement_base"
  fi
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method GET "/repos/tanaabased/big-test-bucket/git/matching-refs/heads/$retirement_base" --jq length)"
  test "$remaining" -eq 0
fi
```

```bash
# should close the remote issue fixture
if test -f "$TMPDIR/approved-issue-number"; then
  cd "$TMPDIR/agent-system-notification-actor"
  issue_number="$(cat "$TMPDIR/approved-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$issue_number" --repo tanaabased/big-test-bucket
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```

```bash
# should stop the selected notification model cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
