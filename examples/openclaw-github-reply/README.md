# OpenClaw Direct GitHub Reply Example

Draft a reply to an explicitly selected unassigned issue in an ordinary chat without publishing it, then publish only after a later explicit request and reconcile that publication without another post. Repeat the same boundary for a verified operator decision as a status update, then return an already-current no-op.

## What Belongs Here

- Operator-supplied facts, selected reply composition, and a retained unpublished draft.
- A later explicit publication request, exact author/body/permalink evidence, and reconciliation of the same receipt.

## What Does Not Belong Here

- Notification activation, admission, or automatic progression: [issue journey](../openclaw-notifications-issue-journey/README.md).
- Managed assessment revision and readback: [conversation continuity](../openclaw-notifications-conversation/README.md).
- Issue investigation and assessment: [direct issue assessment](../openclaw-issue-assessment/README.md).

## Notes

- Strict AIMock reuses the issue protocol for model text and tool selection. Provider reads, native chat execution, and retained results remain real; this does not prove genuine model judgment.
- Install enrolls the native Gateway device credential with both notification schedules paused. Only one unassigned disposable issue is created; no production agent receives an assignment or review request.
- The paused workflow declaration enrolls the native device credential required by the direct tool. This case needs neither an SSH key nor a managed checkout.

## Setup

```bash
# should prepare the packed plugin and strict direct-operation fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --yolo
openclaw-aimock prepare --scenario openclaw-github-reply
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict direct-operation fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" github-reply-emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'

# should enroll native transport while leaving notification schedules paused
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" github-reply-tanaabot || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/tanaabot"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created") and any(.outcomes[]; .code == "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == false)'

# should create one unassigned issue for the direct operation
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System openclaw-github-reply $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -f 'body=Disposable direct operation target; do not assign.' | tee "$TMPDIR/notification-manual-issue.json" | jq -e '.state == "open" and (.assignees | length) == 0'
```

## Testing

```bash
# should draft in an ordinary chat without publishing or admitting work
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/tanaabot"
target=$(jq -er .html_url "$TMPDIR/notification-manual-issue.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:github-reply-tanaabot:manual-reply",agentId:"github-reply-tanaabot",message:("Direct reply draft target: " + $target),deliver:false,idempotencyKey:"notification-manual-draft"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-manual-draft"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-draft 600000
jq -es '[.[].drafts[]] | if length == 1 then .[0] else error("one manual draft required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-manual-draft.json"
jq -e '.publicText != null and .receipt == null and .attempted != true' "$TMPDIR/notification-manual-draft.json"
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e 'length == 0'
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const root = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
const records = readdirSync(root).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(root + '/' + name, 'utf8')).records);
assert.equal(records.length, 0);
NODE

# should publish only after a later explicit request and reconcile without another post
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/emori"
draft_id=$(jq -er .id "$TMPDIR/notification-manual-draft.json")
params=$(jq -nc --arg id "$draft_id" '{sessionKey:"agent:github-reply-tanaabot:manual-reply",agentId:"github-reply-tanaabot",message:("Direct reply publish draft: " + $id),deliver:false,idempotencyKey:"notification-manual-publish"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-manual-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-publish 600000
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-manual-comments.json"
jq -e --slurpfile draft "$TMPDIR/notification-manual-draft.json" 'length == 1 and .[0].user.login == "tanaabot" and (.[0].body | startswith($draft[0].publicText)) and (.[0].body | contains("agent-system-github-publication:manual-response:"))' "$TMPDIR/notification-manual-comments.json"
openclaw gateway call chat.history --params '{"sessionKey":"agent:github-reply-tanaabot:manual-reply","inputRunIds":["notification-manual-publish"],"limit":200,"maxChars":100000}' --json > "$TMPDIR/notification-manual-history.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-manual-"+n+".json","utf8")); const comment=read("comments")[0]; const history=read("history"); const text=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId==="notification-manual-publish" && m.stopReason==="stop").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")).join("\n"); assert.ok(text.includes(comment.html_url)); assert.ok(text.includes(read("draft").publicText));'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'
```

## Status Update

This adds a status draft, a later authorized publication and an already-current
request in the same chat. These three turns prove native input, retained publication
and no-op behavior; strict AIMock supplies materiality judgment, not real reasoning.

```bash
# should retain a typed update draft without publishing or beginning work
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/tanaabot"
conversation="agent:github-reply-tanaabot:manual-reply"
target=$(jq -er .html_url "$TMPDIR/notification-manual-issue.json")
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"github-reply-tanaabot",message:("Operator status update target: " + $target + "\nDecision: use the shared reply approach; implementation remains unstarted. Draft this public update."),deliver:false,idempotencyKey:"notification-status-draft"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-draft"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-draft 600000
jq -es '[.[].drafts[] | select(.update != null)] | if length == 1 then .[0] else error("one status draft required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-status-draft.json"
jq -e '.publicText != null and .receipt == null and .attempted != true' "$TMPDIR/notification-status-draft.json"
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-before.json"

# should publish the original update on a later operator turn and reconcile its receipt
id=$(jq -er .id "$TMPDIR/notification-status-draft.json")
params=$(jq -nc --arg key "$conversation" --arg id "$id" '{sessionKey:$key,agentId:"github-reply-tanaabot",message:("Direct reply publish draft: " + $id),deliver:false,idempotencyKey:"notification-status-publish"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-publish 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-comments.json"
jq -e --slurpfile before "$TMPDIR/notification-status-before.json" --slurpfile draft "$TMPDIR/notification-status-draft.json" 'length == (($before[0] | length) + 1) and ([.[] | select(.body | contains("agent-system-github-publication:status-update:"))] | length) == 1 and any(.[]; .user.login == "tanaabot" and (.body | startswith($draft[0].publicText)))' "$TMPDIR/notification-status-comments.json"
params=$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-status-publish"],limit:200,maxChars:100000}')
openclaw gateway call chat.history --params "$params" --json > "$TMPDIR/notification-status-history.json"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(process.env.TMPDIR + '/notification-status-' + name + '.json', 'utf8'));
const draft = read('draft');
const comment = read('comments').find(value => value.body.includes('agent-system-github-publication:status-update:'));
const text = read('history').messages.filter(value => value.role === 'assistant' && value.__openclaw?.runId === 'notification-status-publish' && value.stopReason === 'stop').map(value => typeof value.content === 'string' ? value.content : value.content.map(part => part.text ?? '').join('')).join('\n');
assert.equal(comment.user.login, 'tanaabot');
assert.ok(text.includes(comment.html_url));
assert.ok(text.includes(draft.publicText));
assert.ok(text.includes('https://github.com/tanaabot'));
assert.ok(text.includes(draft.privateText));
NODE

# should return already-current without another comment or draft
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"github-reply-tanaabot",message:("Check current status target: " + $target),deliver:false,idempotencyKey:"notification-status-current"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-current"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-current 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-after.json"
jq -e --slurpfile before "$TMPDIR/notification-status-comments.json" '. == $before[0]' "$TMPDIR/notification-status-after.json"
jq -es '[.[].drafts[] | select(.update != null)] | length == 1 and .[0].receipt != null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
```

## Cleanup

Cleanup stops the Gateway before changing external fixtures; only this job's issue is closed.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should close only the unassigned direct-operation fixture
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-github-reply/emori"
if test -s "$TMPDIR/notification-manual-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should report strict mock failures and stop the provider
set -o pipefail
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0' || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
