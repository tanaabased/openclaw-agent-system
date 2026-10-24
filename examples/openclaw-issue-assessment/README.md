# OpenClaw Direct Issue Assessment Example

Assess an explicitly selected unassigned issue in an existing checkout through the default assessment wrapper, retain the result in an ordinary chat, and finish without admitting managed issue work, implementation, or publication.

## What Belongs Here

- Default-wrapper selection and a complete retained direct assessment, even when workflow mode is Work.
- An independently prepared repository checkout and assessment-only result with no GitHub comment or managed issue dispatch.

## What Does Not Belong Here

- Notification activation, admission, or automatic progression: [issue journey](../openclaw-notifications-issue-journey/README.md).
- Managed assessment revision and readback: [conversation continuity](../openclaw-notifications-conversation/README.md).
- Reply composition/publication: [direct GitHub reply](../openclaw-github-reply/README.md).

## Notes

- Strict AIMock reuses the issue protocol for model text and tool selection. Provider reads, native chat execution, and retained results remain real; this does not prove genuine model judgment.
- Install enrolls the native Gateway device credential with both notification schedules paused. Only one unassigned disposable issue is created; no production agent receives an assignment or review request.
- Both workflow schedules are paused and the default assessment wrapper is configured before installation. The explicit operation remains assessment-only under Work mode.
- The fixture omits `plan` once, requires a native `result.plan` diagnostic without unrelated outcome requirements, then corrects that shape on the same entry with the complete source unchanged. This proves bounded protocol recovery, not genuine model adaptation.

## Setup

```bash
# should prepare the packed plugin and strict direct-operation fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-assessment
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict direct-operation fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the isolated ssh fixture and run-specific key title
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot/keys" "$HOME/.ssh"
sed -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" issue-assessment-emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'

# should enroll native transport while leaving notification schedules paused
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" issue-assessment-tanaabot || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created") and any(.outcomes[]; .code == "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == false)'

# should create one unassigned issue for the direct operation
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System openclaw-issue-assessment $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -f 'body=Disposable direct operation target; do not assign.' | tee "$TMPDIR/notification-manual-issue.json" | jq -e '.state == "open" and (.assignees | length) == 0'

# should prepare an independent checkout for the explicit assessment
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot"
openclaw agent-system tool worktree -- prepare remote 381-direct-assessment HEAD --clone-url https://github.com/tanaabased/big-test-bucket.git | tee "$TMPDIR/direct-assessment-worktree.json" | jq -e '.status == "created"'
```

## Testing

```bash
# should assess an unassigned issue through the default wrapper without managed issue work or publication
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot"
target=$(jq -er .html_url "$TMPDIR/notification-manual-issue.json")
checkout=$(jq -er .path "$TMPDIR/direct-assessment-worktree.json")
params=$(jq -nc --arg target "$target" --arg checkout "$checkout" '{sessionKey:"agent:issue-assessment-tanaabot:manual-assessment",agentId:"issue-assessment-tanaabot",message:("Direct issue assessment target: " + $target + " checkout: " + $checkout),deliver:false,idempotencyKey:"notification-manual-assessment"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-manual-assessment"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-assessment 600000
jq -es '[.[].entries[]] | length == 1 and .[0].result.outcome == "plan-ready" and (.[0].result.fullAssessment | type == "string" and test("\\S")) and .[0].selection.skill.name == "agent-system-issue-assessment" and .[0].resultTurnId == "notification-manual-assessment"' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-assessment-*.json
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/emori"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e 'length == 0'
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const records = readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records);
assert.equal(records.length, 0);
NODE
```

## Cleanup

Cleanup stops the Gateway before changing external fixtures; only this job's issues and SSH registration are removed.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should remove only the independently prepared clean checkout
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot"
if test -s "$TMPDIR/direct-assessment-worktree.json"; then
  openclaw agent-system tool worktree -- remove remote 381-direct-assessment | jq -e '.status == "removed"'
fi

# should close only the unassigned direct-operation fixture
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/emori"
if test -s "$TMPDIR/notification-manual-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment/tanaabot"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
key_id=$(openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \")) | index(\"$key_material\")) | .id")
if test -n "$key_id"; then
  openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi

# should report strict mock failures and stop the provider
set -o pipefail
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0' || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
