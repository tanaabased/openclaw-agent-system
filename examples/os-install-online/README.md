# Cold Online Install Example

Start the Gateway before the workspace's first Install, enroll dispatch, and activate
intake on macOS and Ubuntu. Check declared and generated automations, preserving the
first attempt's evidence before testing repeat installation.

## What Belongs Here

- Cold first-online enrollment and automation reconciliation without a preparatory offline Install.
- First-attempt output, exit status, redacted Gateway evidence, and the packed Agent System source revision before any repeat.
- Successful repeat retaining the same native jobs and dispatch credential.

## What Does Not Belong Here

- Offline enrollment recovery, consent refusal, and device-only restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Gateway-free installation: [OS install](../os-install/README.md). Automation execution: [automations](../openclaw-automation-command/README.md).

## Notes

- This needs a separate fresh runner because dispatch identity is Gateway-wide; successful online enrollment would invalidate the missing-credential and offline-first conditions in the recovery example. The existing OS matrix gains one scenario on each OS, not another runtime or model matrix.
- Reuse the enrollment example's synthetic GitHub provider. Enrollment and native storage remain real; neither hosted credentials nor a model turn is needed. Both jobs stay disabled.
- Configure a local fixture model with synthetic authentication and explicit catalog metadata before starting the Gateway. Its loopback endpoint has no model server: this scenario verifies model selection during cold Install, without contacting a hosted provider or executing a model turn.
- Setup, first Install, and dependent convergence checks share one fail-fast block. A missing prerequisite or failed first Install ends that journey; no shell retry can turn it green or create misleading downstream failures.
- Session creation uses the shared 120-second budget, subject to earlier cancellation or enclosing deadlines; unrelated requests retain their native timeout. Controlled-time source tests prove the budget, while this scenario proves installed behavior. First-attempt failures remain fatal.
- Enrollment allows up to 90 seconds for startup or plugin reload, within a 135-second connection deadline including authentication. Terminal reload failure and cancellation stop earlier. Session-creation failures report the automation ID and a safe native reason category; `unclassified` means the native rejection is not yet recognized, not that a timeout occurred.
- In CI, the first Install enables bounded, redacted native rejection evidence with `OPENCLAW_DEBUG=1`; it retains no request payload or arbitrary error details.
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
openclaw config set models.providers.install-fixture "$(cat "$GITHUB_WORKSPACE/examples/os-install-online/model-provider.json")" --strict-json
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
openclaw config set cron.enabled false --strict-json
openclaw-gateway start
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
cd "$GITHUB_WORKSPACE/examples/os-install-online"
first_status=0
OPENCLAW_DEBUG=1 openclaw agent-system install --yes --json >"$TMPDIR/online-first.json" 2>"$TMPDIR/online-first.stderr" || first_status=$?
printf '%s\n' "$first_status" >"$TMPDIR/online-first.exit"
cat "$TMPDIR/online-first.json" "$TMPDIR/online-first.stderr"
if ! tail -n 300 "$gateway_log" | node "$gateway_redactor" >"$TMPDIR/online-first.gateway.log"; then printf '%s\n' 'gateway evidence unavailable' >"$TMPDIR/online-first.gateway.log"; fi
if test "$first_status" -ne 0; then cat "$TMPDIR/online-first.gateway.log"; exit "$first_status"; fi
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and all(.warnings[]; .code != "automation-sync-deferred")' "$TMPDIR/online-first.json"
before_status=0
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-before.json" || before_status=$?
if test "$before_status" -ne 1 || ! jq -e '.status == "attention" and ([.findings[] | select(.status != "healthy" and .status != "skipped") | {stepId, status, code}] == [{stepId: "scheduler", status: "blocked", code: "automation-scheduler-disabled"}]) and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and all(.jobs[]; .nativeEnabled == false)' "$TMPDIR/online-jobs-before.json"; then
  printf 'automation list before repeat install exited %s\n' "$before_status" >&2
  jq '{status, jobs: [.jobs[] | {id, nativeEnabled}], findings: [.findings[] | {stepId, status, code}]}' "$TMPDIR/online-jobs-before.json" >&2
  exit 1
fi
openclaw agent-system install --non-interactive --json >"$TMPDIR/online-repeat.json" 2>"$TMPDIR/online-repeat.stderr"
cat "$TMPDIR/online-repeat.json" "$TMPDIR/online-repeat.stderr"
jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged") and all(.outcomes[]; .component != "automations" or .status == "unchanged")' "$TMPDIR/online-repeat.json"
after_status=0
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-after.json" || after_status=$?
if test "$after_status" -ne 1 || ! jq -e '.status == "attention" and ([.findings[] | select(.status != "healthy" and .status != "skipped") | {stepId, status, code}] == [{stepId: "scheduler", status: "blocked", code: "automation-scheduler-disabled"}]) and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and all(.jobs[]; .nativeEnabled == false)' "$TMPDIR/online-jobs-after.json"; then
  printf 'automation list after repeat install exited %s\n' "$after_status" >&2
  jq '{status, jobs: [.jobs[] | {id, nativeEnabled}], findings: [.findings[] | {stepId, status, code}]}' "$TMPDIR/online-jobs-after.json" >&2
  exit 1
fi
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-before.json" >"$TMPDIR/online-identities-before.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-after.json" | diff - "$TMPDIR/online-identities-before.json"
```
