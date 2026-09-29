# GitHub Issue Work Comment Scenario

This GitHub Actions-only scenario proves the `issue` + `work` + `comment` turn. Its setup
establishes and completes a real issue assignment so the comment is reconciled
against a durable active lifecycle. It covers an ordinary comment, a submitted
review with grouped findings, historical locations, a later inline reply, self-authored
feedback rejection, and repeat polling across a Gateway restart. The same lifecycle contract runs against the
deterministic mock provider on pull requests and the live provider through
workflow dispatch.

The scenario creates one disposable issue in `tanaabased/big-test-bucket` and
removes its pull request, branch, generated SSH key, and issue during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario comment \
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
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-comment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system install

# should establish one completed issue lifecycle for comment intake
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "add comment fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create comment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with exactly two lines: comment fixture ready. then review fixture ready." \
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
```

```bash
# should leave a pending review unconsumed
cd "$TMPDIR/agent-system-notification-actor"
branch="$(cat "$TMPDIR/approved-worktree-branch")"
pr="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr list --repo tanaabased/big-test-bucket --head "$branch" --json number --jq '.[0].number')"
printf '%s' "$pr" > "$TMPDIR/review-pr-number"
head="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr view "$pr" --repo tanaabased/big-test-bucket --json headRefOid --jq .headRefOid)"
filename="comment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
jq -n --arg head "$head" --arg path "$filename" '{commit_id: $head, comments: [{path: $path, line: 1, side: "RIGHT", body: "Consider the first line."}, {path: $path, line: 2, side: "RIGHT", body: "Consider the second line."}]}' > "$TMPDIR/pending-review.json"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method POST "/repos/tanaabased/big-test-bucket/pulls/$pr/reviews" --input "$TMPDIR/pending-review.json" > "$TMPDIR/review-created.json"
jq -e '.state == "PENDING" and .submitted_at == null' "$TMPDIR/review-created.json"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw-github-notifications refresh-completed --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 180
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pr/comments" --jq '.[] | select(.body | contains("agent-system-github-publication:github-reply"))' | jq -se 'length == 0'
```

```bash
# should admit one submitted review with two historical findings as one turn
cd "$TMPDIR/agent-system-notification-actor"
pr="$(cat "$TMPDIR/review-pr-number")"
review="$(jq -er .id "$TMPDIR/review-created.json")"
review_token="ready-$GITHUB_RUN_ID-2051"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method POST "/repos/tanaabased/big-test-bucket/pulls/$pr/reviews/$review/events" -f event=COMMENT -f "body=@tanaabot Acknowledge both findings together with $review_token. Do not change files." > "$TMPDIR/review-submitted.json"
jq -e '.state == "COMMENTED" and .submitted_at != null' "$TMPDIR/review-submitted.json"
branch="$(cat "$TMPDIR/approved-worktree-branch")"
filename="comment-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
blob="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api "/repos/tanaabased/big-test-bucket/contents/$filename?ref=$branch" --jq .sha)"
content="$(printf 'replacement fixture line\nreplacement second line\n' | base64 | tr -d '\n')"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method PUT "/repos/tanaabased/big-test-bucket/contents/$filename" -f "branch=$branch" -f "sha=$blob" -f "content=$content" -f 'message=replace disposable review fixture'
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api "/repos/tanaabased/big-test-bucket/pulls/$pr/reviews/$review/comments" > "$TMPDIR/review-findings.json"
  if jq -e 'length == 2 and all(.[]; .position == null and .original_position != null)' "$TMPDIR/review-findings.json"; then break; fi
  sleep 2
done
jq -e 'length == 2 and all(.[]; .position == null and .original_position != null)' "$TMPDIR/review-findings.json"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw-github-notifications refresh-completed --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 180
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pr/comments" --jq '.[] | select(.body | contains("agent-system-github-publication:github-reply"))' | jq -se --arg token "$review_token" 'length == 1 and (.[0].body | contains($token))'
config_root="$(node -p 'process.env.XDG_CONFIG_HOME || require("node:path").join(process.env.HOME, ".config")')"
channel_state="$config_root/tanaab/agent-system/notification-data/channels"
conversation="$(jq -er --arg number "$issue_number" '.conversationIds[] | select(endswith(":" + $number))' "$channel_state/github-notification-conversations.json")"
digest="$(printf '%s' "$conversation" | shasum -a 256 | cut -d ' ' -f 1)"
printf '%s' "$channel_state/github-notification-conversations/$digest.json" > "$TMPDIR/review-conversation-path"
review_node="$(jq -er .node_id "$TMPDIR/review-created.json")"
jq -e --arg node "$review_node" '.conversation.revisions[$node] | .status == "responded" and .publication.status == "published" and .review.kind == "review" and (.review.members | length) == 2' "$(cat "$TMPDIR/review-conversation-path")"
```

```bash
# should discover one later inline reply in the same issue conversation
cd "$TMPDIR/agent-system-notification-actor"
pr="$(cat "$TMPDIR/review-pr-number")"
parent="$(jq -er '.[0].id' "$TMPDIR/review-findings.json")"
reply_token="ready-$GITHUB_RUN_ID-2052"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --method POST "/repos/tanaabased/big-test-bucket/pulls/$pr/comments/$parent/replies" -f "body=@tanaabot Acknowledge this follow-up with $reply_token. Do not change files." > "$TMPDIR/inline-reply.json"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw-github-notifications refresh-completed --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 180
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pr/comments" --jq '.[] | select(.body | contains("agent-system-github-publication:github-reply"))' | jq -se --arg token "$reply_token" 'length == 2 and any(.[]; .body | contains($token))'
reply_node="$(jq -er .node_id "$TMPDIR/inline-reply.json")"
jq -e --arg node "$reply_node" '[.conversation.revisions[] | select(.review.members[$node] != null and .status == "responded" and .publication.status == "published")] | length == 1' "$(cat "$TMPDIR/review-conversation-path")"
```

```bash
# should reject self-authored review feedback and preserve receipts across a restart
cd "$TMPDIR/agent-system-notifications"
pr="$(cat "$TMPDIR/review-pr-number")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method POST "/repos/tanaabased/big-test-bucket/pulls/$pr/reviews" -f event=COMMENT -f 'body=@tanaabot this self-authored review must not start a turn' > "$TMPDIR/self-review.json"
OPENCLAW_NO_RESPAWN=1 openclaw-gateway restart
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw-github-notifications refresh-completed --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 180
openclaw-github-notifications refresh-completed --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 180
self_node="$(jq -er .node_id "$TMPDIR/self-review.json")"
jq -e --arg node "$self_node" '.conversation.revisions[$node] | .status == "rejected" and .reasonCode == "comment-actor-self"' "$(cat "$TMPDIR/review-conversation-path")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$pr/comments" --jq '.[] | select(.body | contains("agent-system-github-publication:github-reply"))' | jq -se 'length == 2'
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.body | contains("agent-system-github-publication:github-reply"))' | jq -se 'length == 1'
```

```bash
# should expose bounded evidence for the selected notification model
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario comment \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-comment/expected-evidence.json"
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

```bash
# should stop the local model provider cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
