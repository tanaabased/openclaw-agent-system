# GitHub Issue Notification Intake Scenario

This macOS-only scenario runs the prepared Agent System package in the default
Gateway and proves the issue-assignment intake lifecycle plus one short comment
exchange. It establishes the polling baseline, rejects a self-authored assignment,
prepares an approved issue worktree, preserves the checkpoint across restart,
publishes one assignment acknowledgment, runs the registered issue/Work/assignment
planning turn, publishes one bounded user-centric active Work plan without
changing the worktree, carries that published plan out through the registered
issue/Work/implementation turn on the next reconciliation, commits the validated
change through Agent System Git, lets the lifecycle prepend the trusted issue
number, pushes the managed branch, creates a normalized pull request assigned
to the issue author, delivers one approved comment through the registered
issue/Work/comment turn contract with its installed identity card, publishes one
reply, and retires the assignment without deleting the worktree.

Scenario setup creates and updates uniquely named issues in
`tanaabased/big-test-bucket`. It registers one generated SSH key for the isolated
run and removes that key and the pushed branch during cleanup.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --needs-secret-service \
  --needs-ssh-key \
  --yolo

# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should prepare notification and approved-actor workspaces
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
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-issue-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

```

## Testing

```bash
# should expose one ready empty notification baseline before assignment intake
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --for baseline-ready \
  --timeout 30 \
  --json | jq -e '.status == "completed" and .code == "github-notification-baseline-ready" and .observation.status == "ready" and .observation.baseline.status == "ready" and (.observation.items | length) == 0'

# should create a self-authored assignment fixture
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-data \
  --repository tanaabased/big-test-bucket \
  --title "agent system rejected notification $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body 'This self-authored assignment must not start local work.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/rejected-issue-number"

# should reject a self-authored issue before lifecycle resource preparation
cd "$TMPDIR/agent-system-notifications"
rejected_issue="$(cat "$TMPDIR/rejected-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$rejected_issue" \
  --for assignment-rejected \
  --refresh \
  --timeout 180 \
  --json | jq -e --argjson number "$rejected_issue" '.status == "completed" and .code == "github-notification-assignment-rejected" and (.observation.items[0] | .itemType == "issue" and .number == $number and .disposition == "rejected" and .reasonCode == "assignment-actor-self" and .worktree == "pending" and (has("stage") | not))'

# should create an approved issue assignment fixture
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "add assignment fixture file $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create assignment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: assignment fixture ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"

# should complete one approved assignment reconciliation
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

# should expose the prepared lifecycle-owned issue worktree
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --timeout 30 \
  --json | jq -e --argjson number "$issue_number" '.status == "completed" and .code == "github-notification-worktree-ready" and (.observation.items[0] | .repository == "tanaabased/big-test-bucket" and .itemType == "issue" and .lifecycleId == "issue" and .number == $number and .disposition == "approved" and .reasonCode == "assignment-approved" and .stage == "prepared" and .worktree == "ready")'

# should publish exactly one bounded assignment acknowledgment
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
acknowledgments="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:initial-acknowledgment"))) | {body, id}')"
acknowledgment="$(jq -sce 'select(length == 1) | .[0]' <<< "$acknowledgments")"
jq -e '.id | type == "number" and . > 0' <<< "$acknowledgment"
jq -e '.body | split("\n\n") | length == 2 and (.[0] | length > 0 and length <= 200) and (.[1] | contains("agent-system-github-publication:initial-acknowledgment"))' <<< "$acknowledgment"

# should publish exactly one bounded assignment response
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
responses="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:assignment-response"))) | {body, id}')"
response="$(jq -sce 'select(length == 1) | .[0]' <<< "$responses")"
jq -e '.id | type == "number" and . > 0' <<< "$response"
jq -e '.body | split("\n\n") as $parts | ($parts | length) >= 2 and ($parts[-1] | contains("agent-system-github-publication:assignment-response")) and (($parts[0:-1] | join("\n\n") | length) > 0) and (($parts[0:-1] | join("\n\n") | length) <= 800)' <<< "$response"

# should leave the planning-only assignment worktree unchanged
cd "$TMPDIR/agent-system-notifications"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_path="$(jq -re 'select(length == 1) | .[0].path' <<< "$worktrees")"
fixture_path="$worktree_path/assignment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
test ! -e "$fixture_path"
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- rev-parse HEAD > "$TMPDIR/implementation-base-sha"

# should complete the next reconciliation and create the assignment fixture
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
test -f "$worktree_path/assignment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"

# should commit only the validated assignment fixture
cd "$TMPDIR/agent-system-notifications"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_path="$(jq -re 'select(length == 1) | .[0].path' <<< "$worktrees")"
worktree_branch="$(jq -re 'select(length == 1) | .[0].branch' <<< "$worktrees")"
fixture_name="assignment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
fixture_path="$worktree_path/$fixture_name"
fixture_contents="$(< "$fixture_path")"
test "$fixture_contents" = 'assignment fixture ready.'
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"
printf '%s' "$worktree_branch" > "$TMPDIR/approved-worktree-branch"

# should create one issue-referenced commit as tanaabot
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

# should create one normalized pull request for the managed branch
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr list --repo tanaabased/big-test-bucket --head "$worktree_branch" --state open --json assignees,author,baseRefName,body,headRefName,number,state,title,url --jq 'select(length == 1) | .[0]')"
jq -e --arg branch "$worktree_branch" --arg title "add assignment fixture file $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" --argjson issue "$issue_number" '.state == "OPEN" and .baseRefName == "main" and .headRefName == $branch and .title == $title and (.body | contains("Closes #" + ($issue | tostring))) and .author.login == "tanaabot" and ([.assignees[].login] | index("emoriwan") != null) and (.url | test("/pull/[1-9][0-9]*$"))' <<< "$pull_request"
jq -r '.number' <<< "$pull_request" > "$TMPDIR/approved-pull-request-number"

# should preserve the durable issue worktree checkpoint across gateway restart
OPENCLAW_NO_RESPAWN=1 openclaw-gateway restart
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --timeout 30 \
  --json | jq -e '.status == "completed" and .code == "github-notification-worktree-ready" and .observation.items[0].stage == "prepared" and .observation.items[0].worktree == "ready"'

# should answer one approved issue comment through the registered turn contract
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
reply_token="ready-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue comment "$issue_number" --repo tanaabased/big-test-bucket --body "@tanaabot Reply briefly with $reply_token. Do not inspect files or perform repository work."
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
replies="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:github-reply"))) | {body, id}')"
reply="$(jq -sce 'select(length == 1) | .[0]' <<< "$replies")"
jq -e '.id | type == "number" and . > 0' <<< "$reply"
jq -e --arg token "$reply_token" '.body | contains("@emoriwan") and contains($token)' <<< "$reply"

# should retire an unassigned issue while retaining its managed worktree
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$issue_number" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and .code == "github-notification-retired" and (.observation.items[0] | .disposition == "retired" and .reasonCode == "item-unassigned" and .stage == "retired" and .worktree == "ready")'
```

## Cleanup

```bash
# should remove only the pushed scenario branch
if test -f "$TMPDIR/approved-worktree-branch"; then
  cd "$TMPDIR/agent-system-notifications"
  if test -f "$TMPDIR/approved-pull-request-number"; then
    pull_request_number="$(cat "$TMPDIR/approved-pull-request-number")"
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr close "$pull_request_number" --repo tanaabased/big-test-bucket
  fi
  worktree_branch="$(cat "$TMPDIR/approved-worktree-branch")"
  if OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --silent --method GET "/repos/tanaabased/big-test-bucket/git/ref/heads/$worktree_branch"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/repos/tanaabased/big-test-bucket/git/refs/heads/$worktree_branch"
  fi
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method GET "/repos/tanaabased/big-test-bucket/git/matching-refs/heads/$worktree_branch" --jq length)"
  test "$remaining" -eq 0
fi

# should remove only the generated tanaabot public key
cd "$TMPDIR/agent-system-notifications"
key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
test -z "$remaining"

# should close the remote issue fixtures without deleting local proof
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
if test -f "$TMPDIR/rejected-issue-number"; then
  rejected_issue="$(cat "$TMPDIR/rejected-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$rejected_issue" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$rejected_issue" --repo tanaabased/big-test-bucket
fi
if test -f "$TMPDIR/approved-issue-number"; then
  approved_issue="$(cat "$TMPDIR/approved-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$approved_issue" --repo tanaabased/big-test-bucket
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```
