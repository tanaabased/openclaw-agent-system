# OpenClaw Manual Task Launch Example

Launch an unassigned issue from an ordinary chat without enabling notification intake.
Create its checkout and issue chat through the enrolled session service, save a Plan
assessment, and reuse the same chat after a Gateway restart. Continue one existing
same-repository draft PR through an authorized update to that original PR.

## What Belongs Here

- Manual-only enrollment and launch without assignment or schedules.
- Native checkout/settings, retained assessment and duplicate-safe destination reuse.
- PR-head startup, original-PR updates and preserved metadata for a PR by another author.

## What Does Not Belong Here

- Scheduled intake: [issue journey](../openclaw-notifications-issue-journey/README.md).
- Assessment in an existing chat: [direct assessment](../openclaw-issue-assessment/README.md).
- Work/Auto and PR delivery permutations beyond this continuation: their existing journeys and component fixtures.

## Notes

- Strict AIMock supplies tool choices and text. Provider access, session creation,
  checkout, restart and retention remain real. This does not prove model judgment or
  standalone Codex desktop creation. The children reuse the existing PR-journey fixture.
- The extra PR adds provider fixture setup and one implementation/delivery turn.
  Native approval denial still needs installed acceptance; component refusals are not that proof.
- One unassigned issue, one PR/source branch and this job's SSH registration need
  external cleanup. Cleanup quiesces the Gateway once before changing them.

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

## Existing PR continuation

```bash
# should prepare one disposable same-repository draft pr by another author
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
branch="agent-system-manual-pr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
base=$(openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket --jq .default_branch)
sha=$(openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/git/ref/heads/$base" --jq .object.sha)
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/git/refs -f "ref=refs/heads/$branch" -f "sha=$sha" | jq -e '.ref != null'
content=$(printf 'Disposable manual PR launch fixture.\n' | base64 | tr -d '\n')
openclaw agent-system tool gh -- api --method PUT "repos/tanaabased/big-test-bucket/contents/manual-pr-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.md" -f "branch=$branch" -f 'message=create disposable manual pr fixture' -f "content=$content" | jq -e '.commit.sha != null'
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/pulls -f "head=$branch" -f "base=$base" -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- manual PR launch" -f 'body=Disposable PR; notification-hidden-initial-fact. Document closing disposable test issues after evidence capture.' -F draft=true > "$TMPDIR/manual-pr.json"
jq -e '.draft == true and .state == "open"' "$TMPDIR/manual-pr.json"

# should launch the draft pr at its observed head through the existing manual workflow
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot"
target=$(jq -er .html_url "$TMPDIR/manual-pr.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:issue-launch-tanaabot:manual-launch",agentId:"issue-launch-tanaabot",message:("Manual issue launch target: " + $target),deliver:false,idempotencyKey:"manual-pr-launch"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "manual-pr-launch"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" manual-pr-launch 600000
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const pr = JSON.parse(readFileSync(process.env.TMPDIR + '/manual-pr.json', 'utf8'));
const records = () => readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records).filter(record => record.manualIssue?.issue.nodeId === pr.node_id);
let record;
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  record = records()[0];
  if (record?.result?.outcome === 'plan-ready') break;
  await setTimeout(1000);
}
assert.equal(records().length, 1);
assert.equal(record?.result?.outcome, 'plan-ready');
assert.equal(record.manualIssue.pullRequest.headSha, pr.head.sha);
assert.equal(record.manualIssue.pullRequest.authorId, pr.user.node_id);
assert.equal(execFileSync('git', ['-C', record.worktree, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), pr.head.sha);
assert.equal(record.effective.status, 'verified');
assert.equal(record.effective.model, 'aimock/gpt-5.5');
assert.equal(record.effective.effort, 'medium');
writeFileSync(process.env.TMPDIR + '/manual-pr-launch.json', JSON.stringify(record));
NODE
child_run=$(jq -er .assessmentTurn.runId "$TMPDIR/manual-pr-launch.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$child_run" 600000

# should send authorized work to the original pr without changing its metadata or draft state
id=$(jq -er .id "$TMPDIR/manual-pr-launch.json")
key=$(jq -er .threadId "$TMPDIR/manual-pr-launch.json")
params=$(jq -nc --arg key "$key" --arg id "$id" '{sessionKey:$key,agentId:"issue-launch-tanaabot",message:("Operator request for managed issue " + $id + ": Implement the cleanup note and update this existing PR. Preserve its title, body, base and draft state."),deliver:false,idempotencyKey:"manual-pr-work"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "manual-pr-work"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" manual-pr-work 600000
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
number=$(jq -er .number "$TMPDIR/manual-pr.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$number" > "$TMPDIR/manual-pr-updated.json"
jq -es '.[0] as $before | .[1] | .node_id == $before.node_id and .head.ref == $before.head.ref and .head.sha != $before.head.sha and .base.ref == $before.base.ref and .title == $before.title and .body == $before.body and .draft == true and .state == "open"' "$TMPDIR/manual-pr.json" "$TMPDIR/manual-pr-updated.json"

# should reuse the completed pr owner without another session or checkout
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/tanaabot"
target=$(jq -er .html_url "$TMPDIR/manual-pr.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:issue-launch-tanaabot:manual-launch",agentId:"issue-launch-tanaabot",message:("Manual issue launch target: " + $target),deliver:false,idempotencyKey:"manual-pr-reuse"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "manual-pr-reuse"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" manual-pr-reuse 600000
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const before = JSON.parse(readFileSync(process.env.TMPDIR + '/manual-pr-launch.json', 'utf8'));
const records = readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records).filter(record => record.manualIssue?.issue.nodeId === before.manualIssue.issue.nodeId);
assert.equal(records.length, 1);
for (const field of ['id', 'threadId', 'worktree', 'resultTurnId']) assert.equal(records[0][field], before[field]);
assert.equal(records[0].work.delivery.pullRequest.pullRequestNodeId, before.manualIssue.issue.nodeId);
assert.equal(records[0].work.delivery.reconciled, true);
assert.equal(records[0].work.delivery.creationAttempted, false);
assert.equal(records[0].work.result.outcome, 'done');
NODE
openclaw agent-system automations list --json | jq -e '.status == "aligned" and (.jobs | length) == 0'
```

## Cleanup

```bash
# should stop the gateway before changing external fixtures
openclaw-gateway stop --timeout 340
touch "$TMPDIR/manual-gateway-stopped"

# should close the disposable pr before removing its source branch after confirmed quiescence
if test -f "$TMPDIR/manual-gateway-stopped" && test -f "$TMPDIR/manual-pr.json"; then
  cd "$GITHUB_WORKSPACE/examples/openclaw-issue-launch/emori"
  number=$(jq -er .number "$TMPDIR/manual-pr.json")
  branch=$(jq -er .head.ref "$TMPDIR/manual-pr.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/pulls/$number" -f state=closed | jq -e '.state == "closed"'
  openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/git/refs/heads/$branch"
fi

# should report strict mock failures and stop the provider
set -o pipefail
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0' || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
