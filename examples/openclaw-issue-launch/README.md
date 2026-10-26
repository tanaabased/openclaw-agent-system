# OpenClaw Manual Issue Launch Example

Launch one unassigned issue from an ordinary chat without notification configuration,
create its checkout and native issue conversation through the existing enrolled session
owner, retain a Plan assessment, then reuse that destination after a Gateway restart.

## What Belongs Here

- Manual-only enrollment and launch without assignment or schedules.
- Native checkout/settings, retained assessment and duplicate-safe destination reuse.

## What Does Not Belong Here

- Scheduled intake: [issue journey](../openclaw-notifications-issue-journey/README.md).
- Assessment in an existing chat: [direct assessment](../openclaw-issue-assessment/README.md).
- Work/Auto and PR delivery permutations: their existing journeys and component fixtures.

## Notes

- Strict AIMock supplies tool choices and text. Provider access, session creation,
  checkout, restart and retention remain real. This does not prove model judgment or
  standalone Codex desktop creation. The child reuses the managed assessment fixture.
- Only one unassigned disposable issue and this job's SSH registration survive the
  runner. Cleanup quiesces the Gateway once before changing them.

## Setup

```bash
# should prepare the packed plugin and strict manual-launch fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-launch
openclaw config set skills.workshop.autonomous.mode off
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the isolated ssh fixture and run-specific key title
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot/keys" "$HOME/.ssh"
sed -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot/agent.yaml" > "$TMPDIR/manual-agent.yaml"
mv "$TMPDIR/manual-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install the fixture creator
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'

# should explicitly enroll native sessions without notification configuration
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot"
openclaw agent-system install --manual-session-dispatch --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and (.jobs | length) == 0'

# should create one unassigned manual-launch target
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System openclaw-issue-launch $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -f 'body=Disposable manual launch target; notification-hidden-initial-fact. Document closing disposable issues after evidence capture; do not assign.' | tee "$TMPDIR/manual-issue.json" | jq -e '.state == "open" and (.assignees | length) == 0'
```

## Testing

```bash
# should create normal managed issue work without assignment or intake
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot"
target=$(jq -er .html_url "$TMPDIR/manual-issue.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:issue-launch-tanaabot:manual-launch",agentId:"issue-launch-tanaabot",message:("Manual issue launch target: " + $target),deliver:false,idempotencyKey:"manual-launch-first"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "manual-launch-first"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" manual-launch-first 600000
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const records = () => readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records);
let record;
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  record = records()[0];
  if (record?.result?.outcome === 'plan-ready') break;
  await setTimeout(1000);
}
assert.equal(records().length, 1);
assert.equal(record?.result?.outcome, 'plan-ready');
assert.ok(record.result.fullAssessment);
assert.equal(record.intakeId, undefined);
assert.equal(record.manualIssue.initiation.kind, 'operator');
assert.equal(record.manualIssue.selections.mode, 'plan');
assert.equal(record.work, undefined);
const described = await callGatewayFromCli('sessions.describe', {json:true}, {key:record.threadId}, {scopes:['operator.admin'],progress:false,sharedStateMode:'read-only'});
assert.equal(realpathSync(described.session.spawnedCwd ?? described.session.workspaceDir), realpathSync(record.worktree));
assert.equal(described.session.sessionId, record.sessionCreation.sessionId);
assert.equal(record.effective.status, 'verified');
writeFileSync(process.env.TMPDIR + '/manual-launch-evidence.json', JSON.stringify(record));
NODE
child_run=$(jq -er .assessmentTurn.runId "$TMPDIR/manual-launch-evidence.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$child_run" 600000
number=$(jq -er .number "$TMPDIR/manual-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number" | jq -e '(.assignees | length) == 0'

# should reuse the verified native destination after gateway restart
openclaw-gateway stop --timeout 340
OPENCLAW_LOG_LEVEL=info openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot"
target=$(jq -er .html_url "$TMPDIR/manual-issue.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:issue-launch-tanaabot:manual-launch",agentId:"issue-launch-tanaabot",message:("Manual issue launch target: " + $target),deliver:false,idempotencyKey:"manual-launch-reuse"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "manual-launch-reuse"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" manual-launch-reuse 600000
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const records = readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records);
const previous = JSON.parse(readFileSync(process.env.TMPDIR + '/manual-launch-evidence.json', 'utf8'));
assert.equal(records.length, 1);
for (const field of ['id', 'threadId', 'worktree', 'resultTurnId']) assert.equal(records[0][field], previous[field]);
assert.deepEqual(records[0].result, previous.result);
NODE
openclaw agent-system automations list --json | jq -e '.status == "aligned" and (.jobs | length) == 0'
```

## Cleanup

```bash
# should stop the gateway before changing external fixtures
openclaw-gateway stop --timeout 340
touch "$TMPDIR/manual-gateway-stopped"

# should report strict mock failures and stop the provider
set -o pipefail
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0' || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
