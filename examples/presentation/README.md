# GitHub Notification Presentation Example

This Ubuntu-only scenario isolates the installed chat-presentation contract from
the issue and pull-request lifecycle scenarios. It verifies one selected issue
assignment card, one direct admitted comment, hidden context and instructions,
and the private/quoted-GitHub response boundary. Scenario setup creates and
closes one uniquely named issue in `tanaabased/agent-system-test`.

## Setup

```bash
# should configure the default openclaw profile with the ci presentation model
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --openai-api-key "$OPENAI_API_KEY" \
  --secret-input-mode plaintext \
  --workspace "$TMPDIR/main" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-health \
  --skip-bootstrap \
  --skip-channels \
  --skip-hooks \
  --skip-search \
  --skip-skills \
  --skip-ui \
  --suppress-gateway-token-output
openclaw models set "openai/$OPENAI_MODEL"
openclaw config set agents.defaults.heartbeat.every "0m"

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should prepare presentation and approved-actor workspaces
mkdir "$TMPDIR/agent-system-presentation"
mkdir "$TMPDIR/agent-system-presentation-actor"
cp "$GITHUB_WORKSPACE/examples/presentation/agent.yaml" "$TMPDIR/agent-system-presentation/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/presentation/actor-agent.yaml" "$TMPDIR/agent-system-presentation-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/presentation-agent-login"

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 "$GITHUB_WORKSPACE/scripts/gateway-process.sh" start

# should install the presentation route and establish its baseline
cd "$TMPDIR/agent-system-presentation"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
"$GITHUB_WORKSPACE/scripts/wait-for-agent-system-github-notification-route.sh" present notification-presentation

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-presentation-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install
```

## Testing

```bash
# should create one approved issue assignment for presentation inspection
cd "$TMPDIR/agent-system-presentation-actor"
agent_login="$(cat "$TMPDIR/presentation-agent-login")"
"$GITHUB_WORKSPACE/scripts/create-and-assign-github-issue.sh" \
  --creator-agent notification-presentation-actor \
  --repository tanaabased/agent-system-test \
  --title "agent system presentation $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT" \
  --body 'Hidden presentation fixture content must remain outside visible chat.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/presentation-issue-number"

# should render the selected assignment card without hidden context or instructions
cd "$TMPDIR/agent-system-presentation"
issue_number="$(cat "$TMPDIR/presentation-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-presentation \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$issue_number" \
  --for planning-complete \
  --refresh \
  --timeout 300 \
  --json | jq -e '.status == "completed" and .observation.items[0].planning.status == "planned"'
session_label="tanaabased/agent-system-test#$issue_number · "
session_key="$(openclaw gateway call sessions.list --params '{"agentId":"notification-presentation"}' --json | jq -er --arg label "$session_label" '[.sessions[]? | select((.origin.label // "") | startswith($label))] | if length == 1 then .[0].key else error("expected selected presentation session") end')"
printf '%s' "$session_key" > "$TMPDIR/presentation-session-key"
params="$(jq -cn --arg sessionKey "$session_key" '{sessionKey:$sessionKey,limit:20,maxChars:120000}')"
history="$(openclaw gateway call chat.history --params "$params" --json)"
printf '%s\n' "$history" | jq -e --arg issue "$issue_number" '
  def visible_text($role):
    [.messages[]? | select(.role == $role) | .. | strings] | join("\n");
  visible_text("assistant") as $assistant
  | visible_text("user") as $user
  | ($user | contains("## 📥 Issue assignment received"))
    and ($user | contains("tanaabased/agent-system-test#" + $issue))
    and ($user | contains("**Mode:** Plan"))
    and ($user | contains("Hidden presentation fixture content") | not)
    and ($user | contains("Work in Plan mode for the assigned GitHub issue") | not)
    and ($user | contains("UntrustedStructuredContext") | not)
    and ($user | contains("/.agent-system/worktrees/") | not)
    and ($assistant | contains("## Assessment"))
    and ($assistant | contains("## Blockers"))
    and ($assistant | contains("## Plan"))
'

# should admit one direct comment and complete its private and github response
cd "$TMPDIR/agent-system-presentation-actor"
agent_login="$(cat "$TMPDIR/presentation-agent-login")"
issue_number="$(cat "$TMPDIR/presentation-issue-number")"
comment_body="@$agent_login Can you summarize the recorded plan in one sentence?"
comment_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-presentation-actor -- api --method POST "repos/tanaabased/agent-system-test/issues/$issue_number/comments" -f "body=$comment_body" --jq .id)"
printf '%s' "$comment_id" > "$TMPDIR/presentation-comment-id"
cd "$TMPDIR/agent-system-presentation"
openclaw agent-system notifications wait \
  --agent notification-presentation \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$issue_number" \
  --comment "$comment_id" \
  --for comment-replied \
  --refresh \
  --timeout 300 \
  --json | jq -e --argjson comment "$comment_id" '.status == "completed" and any(.observation.items[0].comments[]; .commentId == $comment and .reply.status == "published")'

# should render the direct comment and quoted github candidate without model instructions
issue_number="$(cat "$TMPDIR/presentation-issue-number")"
comment_id="$(cat "$TMPDIR/presentation-comment-id")"
agent_login="$(cat "$TMPDIR/presentation-agent-login")"
comment_body="@$agent_login Can you summarize the recorded plan in one sentence?"
source="https://github.com/tanaabased/agent-system-test/issues/$issue_number#issuecomment-$comment_id"
session_key="$(cat "$TMPDIR/presentation-session-key")"
params="$(jq -cn --arg sessionKey "$session_key" '{sessionKey:$sessionKey,limit:40,maxChars:120000}')"
history="$(openclaw gateway call chat.history --params "$params" --json)"
printf '%s\n' "$history" | jq -e --arg comment "$comment_body" --arg source "$source" '
  def visible_text($role):
    [.messages[]? | select(.role == $role) | .. | strings] | join("\n");
  visible_text("assistant") as $assistant
  | visible_text("user") as $user
  | ($user | contains($comment))
    and ($user | contains($source) | not)
    and ($user | contains("Continue the assigned GitHub issue conversation") | not)
    and ($user | contains("Return exactly one private Markdown response") | not)
    and ($user | contains("GITHUB_COMMENT_JSON") | not)
    and ($user | contains("STATUS_EVIDENCE_JSON") | not)
    and ($assistant | contains("## 💬 Comment answered"))
    and ($assistant | contains("## Response"))
    and ($assistant | contains("## 📤 To GitHub\n\n> "))
'
cd "$TMPDIR/agent-system-presentation-actor"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-presentation-actor -- api "repos/tanaabased/agent-system-test/issues/$issue_number/comments" --jq '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:github-reply")))] as $replies | ($replies | length) >= 1 and all($replies[]; (.body | contains("## Response") | not) and (.body | contains("## 📤 To GitHub") | not))' | grep -Fx 'true'
```

## Cleanup

```bash
# should close the presentation fixture without deleting local proof
cd "$TMPDIR/agent-system-presentation-actor"
if test -f "$TMPDIR/presentation-issue-number"; then
  issue_number="$(cat "$TMPDIR/presentation-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-presentation-actor -- issue close "$issue_number" --repo tanaabased/agent-system-test
fi

# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
