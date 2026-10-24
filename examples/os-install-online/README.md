# Cold Online Install Example

Start the Gateway before the workspace's first Install, enroll dispatch, activate intake, and reconcile declared and derived automations on macOS and Ubuntu. Preserve the first attempt before checking successful convergence.

## What Belongs Here

- Cold first-online enrollment and automation reconciliation without a preparatory offline Install.
- First-attempt output, exit status, redacted Gateway evidence, and the packed Agent System source revision before any repeat.
- Successful repeat retaining the same native jobs, intake session, and dispatch credential.

## What Does Not Belong Here

- Offline enrollment recovery, consent refusal, and device-only restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Gateway-free installation: [OS install](../os-install/README.md). Automation execution: [automations](../openclaw-automations/README.md).

## Notes

- This needs a separate fresh runner because dispatch identity is Gateway-wide; successful online enrollment would invalidate the missing-credential and offline-first conditions in the recovery example. The existing OS matrix gains one scenario on each OS, not another runtime or model matrix.
- Reuse the enrollment example's synthetic GitHub provider. Enrollment and native storage remain real; neither hosted credentials nor a model turn is needed. Both jobs stay disabled.
- Setup, first Install, and dependent convergence checks share one fail-fast block. A missing prerequisite or failed first Install ends that journey; no shell retry can turn it green or create misleading downstream failures.
- Evidence is saved beneath `TMPDIR` before a repeat can change state. A Gateway log observation alone does not establish the failure's cause.

## Setup

The packed plugin and native credential backend are prepared in the same block as the first online installation, so setup failure cannot be mistaken for an independent installation failure.

## Testing

```bash
# should complete a cold first online installation before checking convergence
set -euo pipefail
git -C "$GITHUB_WORKSPACE" rev-parse HEAD | tee "$TMPDIR/online-agent-system-revision.txt"
chmod +x "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider/gh"
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
openclaw-gateway start
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
cd "$GITHUB_WORKSPACE/examples/os-install-online"
first_status=0
openclaw agent-system install --yes --json >"$TMPDIR/online-first.json" 2>"$TMPDIR/online-first.stderr" || first_status=$?
printf '%s\n' "$first_status" >"$TMPDIR/online-first.exit"
cat "$TMPDIR/online-first.json" "$TMPDIR/online-first.stderr"
if ! tail -n 300 "$gateway_log" | node "$gateway_redactor" >"$TMPDIR/online-first.gateway.log"; then printf '%s\n' 'gateway evidence unavailable' >"$TMPDIR/online-first.gateway.log"; fi
if test "$first_status" -ne 0; then cat "$TMPDIR/online-first.gateway.log"; exit "$first_status"; fi
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and all(.warnings[]; .code != "automation-sync-deferred")' "$TMPDIR/online-first.json"
openclaw agent-system automations list --json | tee "$TMPDIR/online-jobs-before.json" | jq -e '.status == "aligned" and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and all(.jobs[]; .nativeEnabled == false)'
intake_key=$(jq -er '.jobs[] | select(.id == "github-issue-assignment") | .routing | select(startswith("session:")) | ltrimstr("session:")' "$TMPDIR/online-jobs-before.json")
openclaw gateway call sessions.list --params '{"agentId":"install-data","includeDerivedTitles":false,"includeLastMessage":false}' --json >"$TMPDIR/online-sessions-before.json"
jq -e --arg key "$intake_key" '[.sessions[] | select(.key | startswith("agent:install-data:automation:"))] | length == 1 and .[0].key == $key' "$TMPDIR/online-sessions-before.json"
openclaw agent-system install --non-interactive --json >"$TMPDIR/online-repeat.json"
jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged") and all(.outcomes[]; .component != "automations" or .status == "unchanged")' "$TMPDIR/online-repeat.json"
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-after.json"
openclaw gateway call sessions.list --params '{"agentId":"install-data","includeDerivedTitles":false,"includeLastMessage":false}' --json >"$TMPDIR/online-sessions-after.json"
jq -e --arg key "$intake_key" --slurpfile before "$TMPDIR/online-sessions-before.json" '[.sessions[] | select(.key | startswith("agent:install-data:automation:"))] | length == 1 and .[0].key == $key and .[0].sessionId == ($before[0].sessions[] | select(.key == $key) | .sessionId)' "$TMPDIR/online-sessions-after.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-before.json" >"$TMPDIR/online-identities-before.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-after.json" | diff - "$TMPDIR/online-identities-before.json"
```
