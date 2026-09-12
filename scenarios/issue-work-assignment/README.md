# GitHub Issue Work Assignment Scenario

The one-shot CLI currently cannot resolve channel-qualified owner grants without
the active channel registry. Its strict model fixture must still publish the plan
when the optional `sessions` tool is absent. The
[operator-access Gateway scenario](../issue-work-operator-access/README.md) owns
the positive owner/color/group persistence and authorization controls.

This GitHub Actions-only scenario proves the CLI `issue` + `work` + `assignment` turn. It
checks assignment admission, lifecycle worktree preparation, the deterministic
acknowledgment, delivery of the created issue title and body as bounded private
context, graceful continuation without optional session setup, one assessment and plan, and the
planning-only worktree checkpoint. The same lifecycle contract runs against the
deterministic mock provider on pull requests and
the live provider through workflow dispatch. It does not continue into implementation.
It also checks that the installed runtime saves publication receipts in the owning
conversation file and keeps only routing identity in the shared index. A controlled
per-issue execution lease verifies that intake can admit an issue before execution is available,
and that the bounded CLI refresh reports its wait ending without losing that admission.
While that lease remains held, a second issue reaches a prepared worktree and fails
after the scenario removes its classifier grant. `doctor` identifies the drift,
`install` repairs it, and the issue resumes the same worktree and conversation.
Releasing the first issue then proves that its resumed execution preserves the second issue. The hold models a busy executor; overlapping
model turns, comment workers, failure isolation, and shutdown are covered by unit tests.

Complete model profiles opt both issues into a separate tool-free assessment. The
strict fixture checks bounded issue content and absence of tools; the dispatcher
requires the native work selection to report the saved model and medium effort.
The durable record independently retains that selection across CLI runs. AIMock
does not retain wire-level reasoning effort, so this scenario does not prove the
provider's applied reasoning budget. Cost and rework sampling remains a separate,
explicitly authorized live evaluation before broad rollout.

The scenario creates uniquely named disposable issues in
`tanaabased/big-test-bucket` and removes its generated SSH key during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario assignment \
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

# should configure complete profiles with a high effort classifier and medium effort low tier
printf '\nmodels:\n  default:\n    model: %s\n    effort: high\n  low:\n    model: %s\n    effort: medium\n  medium:\n    model: %s\n    effort: high\n  high:\n    model: %s\n    effort: high\n' "$NOTIFICATION_MODEL" "$NOTIFICATION_MODEL" "$NOTIFICATION_MODEL" "$NOTIFICATION_MODEL" >> "$TMPDIR/agent-system-notifications/agent.yaml"

# should preserve unrelated llm permissions while classifier access remains absent
openclaw config set plugins.entries.agent-system.llm.allowAuthProfileOverride true --strict-json
openclaw config set plugins.entries.agent-system.llm.allowedModels '["aimock/retained"]' --strict-json
openclaw config set plugins.entries.agent-system.llm.allowedCompletionModels '["aimock/retained"]' --strict-json

# should leave operator grants for the normal manifest installation to reconcile
openclaw config set commands.ownerAllowFrom '[]' --strict-json

# should require normal install to repair missing hook consent
openclaw config unset plugins.entries.agent-system.hooks.allowConversationAccess

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should make existing custom groups available for assignment setup
openclaw gateway call sessions.groups.put --params '{"names":["Reading","Active Work"]}' --json | jq -e '.ok == true'

# should install the route and establish the first baseline synchronously
cd "$TMPDIR/agent-system-notifications"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-model-routing-access-reconciled" and .status == "updated")'
openclaw config get plugins.entries.agent-system.llm --json | jq -e --arg model "$NOTIFICATION_MODEL" '.allowAgentIdOverride == true and .allowModelOverride == true and .allowAuthProfileOverride == true and .allowedModels == ["aimock/retained", $model] and .allowedCompletionModels == ["aimock/retained", $model]'
openclaw plugins inspect agent-system --runtime --json | jq -e '.policy.allowConversationAccess == true and any(.typedHooks[]; .name == "before_prompt_build")'
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
openclaw config get commands.ownerAllowFrom --json | jq -e 'index("agent-system-github:U_kgDOEUqvpg") != null'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should remove only classifier access to reproduce installed configuration drift
openclaw config unset plugins.entries.agent-system.llm.allowAgentIdOverride
openclaw config unset plugins.entries.agent-system.llm.allowModelOverride
openclaw config set plugins.entries.agent-system.llm.allowedModels '["aimock/retained"]' --strict-json
openclaw config set plugins.entries.agent-system.llm.allowedCompletionModels '["aimock/retained"]' --strict-json

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-assignment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
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

# should reject a self authored issue before lifecycle resource preparation
cd "$TMPDIR/agent-system-notifications"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-data \
  --repository tanaabased/big-test-bucket \
  --title "agent system rejected assignment $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body 'This self-authored assignment must not start local work.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/rejected-issue-number"
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

# should keep native session tools available while the cli owns notification execution
openclaw-gateway stop
OPENCLAW_NO_RESPAWN=1 OPENCLAW_SKIP_CHANNELS=1 openclaw-gateway start

# should admit an approved issue while a bounded refresh cannot acquire its execution lease
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "bug: add assignment planning fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create assignment-planning-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: assignment planning ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
repository_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api /repos/tanaabased/big-test-bucket --jq .node_id)"
execution_key="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "github:$repository_id:$issue_number")"
config_root="$(node -p 'process.env.XDG_CONFIG_HOME || require("node:path").join(process.env.HOME, ".config")')"
execution_root="$config_root/tanaab/agent-system/notification-data/channels/github-notification-execution"
mkdir -p -m 700 "$execution_root"
execution_lock="$execution_root/$execution_key.lock"
mkdir "$execution_lock"
printf '%s' "$execution_lock" > "$TMPDIR/notification-execution-lock"
blocked_refresh="$(openclaw agent-system notifications refresh --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --timeout 30 --json || true)"
jq -se 'length == 1 and (.[0] | .status == "skipped" and .code == "github-notification-cycle-aborted" and (.lastSuccessfulPollAt | type) == "number")' <<< "$blocked_refresh"
openclaw agent-system notifications status --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$issue_number" --json | jq -e --argjson number "$issue_number" '.status == "ready" and (.items | length) == 1 and (.items[0] | .number == $number and .disposition == "approved" and .stage == "admitted" and .worktree == "pending")'

# should retain a prepared independent assignment when native classification is denied
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "bug: add assignment planning fixture independent $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create assignment-planning-independent-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: assignment planning ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/independent-issue-number"
cd "$TMPDIR/agent-system-notifications"
independent_issue="$(cat "$TMPDIR/independent-issue-number")"
routing_failure="$(openclaw agent-system notifications refresh --agent notification-data --repository tanaabased/big-test-bucket --kind issue --number "$independent_issue" --timeout 420 --json || true)"
jq -se 'length == 1 and (.[0] | .status == "failed" and .code == "github-notification-routing-classification-failed")' <<< "$routing_failure"
test -d "$(cat "$TMPDIR/notification-execution-lock")"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications status --agent notification-data --json | jq -e --argjson blocked "$issue_number" --argjson ready "$independent_issue" '([.items[] | select(.number == $blocked and .disposition == "approved" and .stage == "admitted" and .worktree == "pending")] | length) == 1 and ([.items[] | select(.number == $ready and .disposition == "approved" and .stage == "prepared" and .worktree == "ready")] | length) == 1'
config_root="$(node -p 'process.env.XDG_CONFIG_HOME || require("node:path").join(process.env.HOME, ".config")')"
channel_state="$config_root/tanaab/agent-system/notification-data/channels"
conversation_id="$(jq -er --arg number "$independent_issue" '.conversationIds[] | select(endswith(":" + $number))' "$channel_state/github-notification-conversations.json")"
record_digest="$(printf '%s' "$conversation_id" | shasum -a 256 | cut -d ' ' -f 1)"
jq -e '.conversation.modelRouting.profiles.default.model != null and (.conversation.modelRouting | has("decision") | not) and (.conversation | has("assignmentResponse") | not)' "$channel_state/github-notification-conversations/$record_digest.json"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
jq -re 'select(length == 1) | .[0].path' <<< "$worktrees" > "$TMPDIR/independent-worktree-before"
printf '%s' "$conversation_id" > "$TMPDIR/independent-conversation-id-before"

# should diagnose and reconcile only the missing classifier access
doctor_before="$(openclaw agent-system doctor --json)"
printf '%s\n' "$doctor_before" | jq -e --arg model "$NOTIFICATION_MODEL" '.findings[] | select(.component == "github-notifications" and .code == "github-model-routing-access-drift" and .status == "drift" and (.message | contains($model)))'
repair="$(openclaw agent-system install --json)"
printf '%s\n' "$repair" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-model-routing-access-reconciled" and .status == "updated")'
openclaw config get plugins.entries.agent-system.llm --json | jq -e --arg model "$NOTIFICATION_MODEL" '.allowAgentIdOverride == true and .allowModelOverride == true and .allowAuthProfileOverride == true and .allowedModels == ["aimock/retained", $model] and .allowedCompletionModels == ["aimock/retained", $model]'
openclaw agent-system doctor --json | jq -e --arg model "$NOTIFICATION_MODEL" '.findings[] | select(.component == "github-notifications" and .code == "github-model-routing-access-ready" and .status == "healthy" and (.message | contains($model)))'
repeat="$(openclaw agent-system install --json)"
printf '%s\n' "$repeat" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-model-routing-access-reconciled" and .status == "unchanged")'

# should resume the same prepared independent assignment after access repair
openclaw-github-notifications refresh-completed \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$independent_issue" \
  --timeout 420 | jq -e '.status == "completed" and .code == "github-notification-poll-complete"'
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
jq -e --rawfile path "$TMPDIR/independent-worktree-before" 'length == 1 and .[0].path == ($path | rtrimstr("\n"))' <<< "$worktrees"
conversation_id="$(jq -er --arg number "$independent_issue" '.conversationIds[] | select(endswith(":" + $number))' "$channel_state/github-notification-conversations.json")"
test "$conversation_id" = "$(cat "$TMPDIR/independent-conversation-id-before")"
record_digest="$(printf '%s' "$conversation_id" | shasum -a 256 | cut -d ' ' -f 1)"
jq -e '.conversation.acknowledgment.status == "published" and .conversation.assignmentResponse.status == "published" and .conversation.modelRouting.decision.complexity == "low"' "$channel_state/github-notification-conversations/$record_digest.json"
cp "$channel_state/github-notification-conversations/$record_digest.json" "$TMPDIR/independent-conversation-before.json"

# should resume the admitted issue from a new process after execution is released
rmdir "$(cat "$TMPDIR/notification-execution-lock")"
rm "$TMPDIR/notification-execution-lock"
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

# should expose the prepared lifecycle owned issue worktree
cd "$TMPDIR/agent-system-notifications"
for issue_number in "$(cat "$TMPDIR/approved-issue-number")" "$(cat "$TMPDIR/independent-issue-number")"; do
  openclaw agent-system notifications wait \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --for worktree-ready \
    --timeout 30 \
    --json | jq -e --argjson number "$issue_number" '.status == "completed" and .code == "github-notification-worktree-ready" and (.observation.items[0] | .repository == "tanaabased/big-test-bucket" and .itemType == "issue" and .lifecycleId == "issue" and .number == $number and .disposition == "approved" and .reasonCode == "assignment-approved" and .stage == "prepared" and .worktree == "ready")'
done

# should publish exactly one bounded assignment acknowledgment
cd "$TMPDIR/agent-system-notification-actor"
for issue_number in "$(cat "$TMPDIR/approved-issue-number")" "$(cat "$TMPDIR/independent-issue-number")"; do
  acknowledgments="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:initial-acknowledgment"))) | {body, id}')"
  acknowledgment="$(jq -sce 'select(length == 1) | .[0]' <<< "$acknowledgments")"
  jq -e '.id | type == "number" and . > 0' <<< "$acknowledgment"
  jq -e '.body | split("\n\n") | length == 2 and (.[0] | length > 0 and length <= 200) and (.[1] | contains("agent-system-github-publication:initial-acknowledgment"))' <<< "$acknowledgment"
done

# should publish exactly one bounded assignment response
cd "$TMPDIR/agent-system-notification-actor"
for issue_number in "$(cat "$TMPDIR/approved-issue-number")" "$(cat "$TMPDIR/independent-issue-number")"; do
  responses="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:assignment-response"))) | {body, id}')"
  response="$(jq -sce 'select(length == 1) | .[0]' <<< "$responses")"
  jq -e '.id | type == "number" and . > 0' <<< "$response"
  jq -e '.body | split("\n\n") as $parts | ($parts | length) >= 2 and ($parts[-1] | contains("agent-system-github-publication:assignment-response")) and (($parts[0:-1] | join("\n\n") | length) > 0) and (($parts[0:-1] | join("\n\n") | length) <= 800)' <<< "$response"
done

# should persist assignment receipts in the owning conversation file
config_root="$(node -p 'process.env.XDG_CONFIG_HOME || require("node:path").join(process.env.HOME, ".config")')"
channel_state="$config_root/tanaab/agent-system/notification-data/channels"
jq -e '.schemaVersion == 8 and .agentId == "notification-data" and (has("conversations") | not) and (.conversationIds | length) == 2 and (.conversationIds | unique | length) == 2' "$channel_state/github-notification-conversations.json"
for issue_number in "$(cat "$TMPDIR/approved-issue-number")" "$(cat "$TMPDIR/independent-issue-number")"; do
  conversation_id="$(jq -er --arg number "$issue_number" '.conversationIds[] | select(endswith(":" + $number))' "$channel_state/github-notification-conversations.json")"
  record_digest="$(printf '%s' "$conversation_id" | shasum -a 256 | cut -d ' ' -f 1)"
  jq -e --arg model "$NOTIFICATION_MODEL" --arg id "$conversation_id" --arg number "$issue_number" --arg workspace "$TMPDIR/agent-system-notifications" '.schemaVersion == 2 and .agentId == "notification-data" and .conversationId == $id and (.conversationId | endswith(":" + $number)) and .workspaceDir == $workspace and .conversation.acknowledgment.status == "published" and .conversation.assignmentResponse.status == "published" and .conversation.modelRouting.decision.model == $model and .conversation.modelRouting.decision.complexity == "low" and .conversation.modelRouting.applied == {model: $model, effort: "medium"}' "$channel_state/github-notification-conversations/$record_digest.json"
done

# should preserve the independent conversation exactly when the first issue resumes
config_root="$(node -p 'process.env.XDG_CONFIG_HOME || require("node:path").join(process.env.HOME, ".config")')"
channel_state="$config_root/tanaab/agent-system/notification-data/channels"
independent_issue="$(cat "$TMPDIR/independent-issue-number")"
conversation_id="$(jq -er --arg number "$independent_issue" '.conversationIds[] | select(endswith(":" + $number))' "$channel_state/github-notification-conversations.json")"
record_digest="$(printf '%s' "$conversation_id" | shasum -a 256 | cut -d ' ' -f 1)"
cmp "$TMPDIR/independent-conversation-before.json" "$channel_state/github-notification-conversations/$record_digest.json"
```

```bash
# should finish assignment planning despite unavailable optional cli session setup
for issue_number in "$(cat "$TMPDIR/approved-issue-number")" "$(cat "$TMPDIR/independent-issue-number")"; do
  openclaw gateway call sessions.list --params '{"agentId":"notification-data"}' --json | jq -e --arg suffix ":$issue_number" '[.sessions[] | select(.key | endswith($suffix))] | length == 1 and .[0].color == null and .[0].category == null'
done
```

```bash
# should expose bounded evidence for the selected notification model
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario assignment \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-assignment/expected-evidence.json"
```

```bash
# should leave the planning only assignment worktree unchanged
cd "$TMPDIR/agent-system-notifications"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_paths="$(jq -re 'select(length == 2 and (map(.path) | unique | length) == 2) | .[].path' <<< "$worktrees")"
while IFS= read -r worktree_path; do
  test ! -e "$worktree_path/assignment-planning-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
  test ! -e "$worktree_path/assignment-planning-independent-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
  cd "$worktree_path"
  status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
  test -z "$status"
done <<< "$worktree_paths"
```

## Cleanup

```bash
# should release the scenario owned execution hold if an assertion failed
if test -f "$TMPDIR/notification-execution-lock"; then
  execution_lock="$(cat "$TMPDIR/notification-execution-lock")"
  if test -d "$execution_lock"; then
    rmdir "$execution_lock"
  fi
fi

# should remove only the generated tanaabot public key
if test -f "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
  test -z "$remaining"
fi

# should close the remote issue fixtures
if test -d "$TMPDIR/agent-system-notification-actor"; then
  cd "$TMPDIR/agent-system-notification-actor"
  agent_login="$(cat "$TMPDIR/notification-agent-login")"
  if test -f "$TMPDIR/rejected-issue-number"; then
    rejected_issue="$(cat "$TMPDIR/rejected-issue-number")"
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$rejected_issue" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$rejected_issue" --repo tanaabased/big-test-bucket
  fi
  for issue_path in "$TMPDIR/approved-issue-number" "$TMPDIR/independent-issue-number"; do
    if test -f "$issue_path"; then
      approved_issue="$(cat "$issue_path")"
      OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$approved_issue" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
      OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$approved_issue" --repo tanaabased/big-test-bucket
    fi
  done
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```

```bash
# should stop the local model provider cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
