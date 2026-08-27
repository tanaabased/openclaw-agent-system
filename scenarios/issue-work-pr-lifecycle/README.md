# GitHub Issue Work PR Lifecycle Scenario

This GitHub Actions-only scenario proves the complete delivery pull-request
lifecycle for an `issue` + `work` assignment. One disposable issue progresses
through managed pull-request creation, the private `pull-request-opened` turn,
the visible issue handoff, one source-affine pull-request reply, closed-unmerged
recovery, reopen baselining, merge-driven retirement, session archival, and
clean worktree removal. The same lifecycle contract runs against the
deterministic mock provider on pull requests and the live provider through
workflow dispatch.

The scenario creates one disposable issue, pull request, head branch, and
temporary base branch in `tanaabased/big-test-bucket`, then removes every
remaining remote fixture, generated SSH key, and issue during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario pr-lifecycle \
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
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-pull-request-lifecycle-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should prepare one planned issue for the pull request lifecycle
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "complete pull request lifecycle fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create pull-request-lifecycle-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: pull request lifecycle fixture ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"

# should plan and implement the assignment before delivery reconciliation
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
for phase in assignment implementation; do
  refresh_result="$(
    openclaw-github-notifications refresh-completed \
      --agent notification-data \
      --repository tanaabased/big-test-bucket \
      --kind issue \
      --number "$issue_number" \
      --timeout 420
  )"
  jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
  if [[ "$phase" == 'assignment' ]]; then
    worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
    jq -re 'select(length == 1) | .[0].branch' <<< "$worktrees" > "$TMPDIR/approved-worktree-branch"
  fi
done
```

## Testing

```bash
# should create one normalized pull request and publish one issue handoff
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr list --repo tanaabased/big-test-bucket --head "$worktree_branch" --state open --json assignees,author,baseRefName,body,headRefName,number,state,title,url --jq 'select(length == 1) | .[0]')"
jq -e --arg branch "$worktree_branch" --arg title "complete pull request lifecycle fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" --argjson issue "$issue_number" '.state == "OPEN" and .baseRefName == "main" and .headRefName == $branch and .title == $title and (.body | contains("Closes #" + ($issue | tostring))) and .author.login == "tanaabot" and ([.assignees[].login] | index("emoriwan") != null)' <<< "$pull_request"
jq -r '.number' <<< "$pull_request" > "$TMPDIR/approved-pull-request-number"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
handoffs="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:pull-request-handoff"))) | {body, id}')"
handoff="$(jq -sce 'select(length == 1) | .[0]' <<< "$handoffs")"
jq -e --arg pull_request "#$pull_request_number" '.id | type == "number" and . > 0' <<< "$handoff"
jq -e --arg pull_request "#$pull_request_number" '.body | contains("## Pull request opened") and contains("**Pull request:** " + $pull_request) and contains("**Conversation:**") and contains("**Replies:**")' <<< "$handoff"
```

```bash
# should answer an approved pull request comment on its exact source item
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
issue_reply_count_before="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:github-reply")))] | length')"
reply_token="pr-ready-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr comment "$pull_request_number" --repo tanaabased/big-test-bucket --body "@tanaabot Reply briefly with $reply_token. Do not inspect files or perform repository work."
cd "$TMPDIR/agent-system-notifications"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 180
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
cd "$TMPDIR/agent-system-notification-actor"
replies="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pull_request_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:github-reply"))) | {body, id}')"
reply="$(jq -sce 'select(length == 1) | .[0]' <<< "$replies")"
jq -e '.id | type == "number" and . > 0' <<< "$reply"
jq -e --arg token "$reply_token" '.body | contains("@emoriwan") and contains($token)' <<< "$reply"
issue_reply_count_after="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:github-reply")))] | length')"
test "$issue_reply_count_after" -eq "$issue_reply_count_before"
```

```bash
# should recover the issue-owned session after a closed-unmerged pull request
cd "$TMPDIR/agent-system-notification-actor"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr close "$pull_request_number" --repo tanaabased/big-test-bucket
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json mergedAt,state | jq -e '.state == "CLOSED" and .mergedAt == null'
baseline_token="pr-baseline-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
printf '%s' "$baseline_token" > "$TMPDIR/pull-request-baseline-token"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr comment "$pull_request_number" --repo tanaabased/big-test-bucket --body "@tanaabot Ignore this closed pull request baseline marker: $baseline_token."
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 180
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
openclaw agent-system notifications status \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --json | jq -e --argjson issue "$issue_number" '.status == "ready" and .code == "github-notification-status-ready" and (.items | length == 1) and (.items[0] | .repository == "tanaabased/big-test-bucket" and .itemType == "issue" and .lifecycleId == "issue" and .number == $issue and .disposition == "approved" and .reasonCode == "assignment-approved" and .stage == "prepared" and .worktree == "ready")'
```

```bash
# should reopen and baseline comments that arrived while the pull request was closed
cd "$TMPDIR/agent-system-notification-actor"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
baseline_token="$(cat "$TMPDIR/pull-request-baseline-token")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr reopen "$pull_request_number" --repo tanaabased/big-test-bucket
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json state --jq .state | grep -Fx OPEN
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
for baseline_pass in status comments; do
  refresh_result="$(
    openclaw-github-notifications refresh-completed \
      --agent notification-data \
      --repository tanaabased/big-test-bucket \
      --kind issue \
      --number "$issue_number" \
      --timeout 180
  )"
  jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
done
cd "$TMPDIR/agent-system-notification-actor"
baseline_replies="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pull_request_number/comments" --jq "[.[] | select(.user.login == \"tanaabot\" and (.body | contains(\"agent-system-github-publication:github-reply\")) and (.body | contains(\"$baseline_token\")))] | length")"
test "$baseline_replies" -eq 0
```

```bash
# should retarget the reopened pull request to one disposable non-default base
cd "$TMPDIR/agent-system-notification-actor"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
retirement_base="agent-system-pr-lifecycle-base-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS"
printf '%s' "$retirement_base" > "$TMPDIR/retirement-base-branch"
base_sha="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api "/repos/tanaabased/big-test-bucket/git/ref/heads/main" --jq .object.sha)"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method POST /repos/tanaabased/big-test-bucket/git/refs -f "ref=refs/heads/$retirement_base" -f "sha=$base_sha" --jq .ref
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr edit "$pull_request_number" --repo tanaabased/big-test-bucket --base "$retirement_base"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json baseRefName --jq .baseRefName | grep -Fx "$retirement_base"
mergeable=''
for attempt in $(seq 1 30); do
  mergeable="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json mergeable --jq .mergeable)"
  case "$mergeable" in
    MERGEABLE) break ;;
    CONFLICTING) exit 1 ;;
    UNKNOWN) sleep 1 ;;
    *) exit 1 ;;
  esac
done
case "$mergeable" in
  MERGEABLE | UNKNOWN) ;;
  *) exit 1 ;;
esac
```

```bash
# should merge without closing the issue, then retire and clean the lifecycle
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
retirement_base="$(cat "$TMPDIR/retirement-base-branch")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr merge "$pull_request_number" --repo tanaabased/big-test-bucket --merge
merged_pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pull_request_number" --repo tanaabased/big-test-bucket --json baseRefName,mergedAt,mergedBy,state)"
jq -e --arg base "$retirement_base" '.state == "MERGED" and .mergedAt != null and .mergedBy.login == "emoriwan" and .baseRefName == $base' <<< "$merged_pull_request"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue view "$issue_number" --repo tanaabased/big-test-bucket --json state --jq .state | grep -Fx OPEN
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and .code == "github-notification-retired" and (.observation.items[0] | .disposition == "retired" and .reasonCode == "pull-request-merged" and .stage == "retired")'
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
  --scenario pr-lifecycle \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-pr-lifecycle/expected-evidence.json"
```

## Cleanup

```bash
# should remove only the generated tanaabot public key
if test -s "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
  test -z "$remaining"
fi

# should remove only the delivery head branch when it remains
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

```bash
# should stop the selected notification model cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
