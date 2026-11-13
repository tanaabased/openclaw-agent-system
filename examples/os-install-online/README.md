# Cold Online Install Example

Start the Gateway before the workspace's first Install, enroll dispatch, and activate
intake on macOS and Ubuntu. Check declared and generated automations, preserving the
first attempt's evidence before testing repeat installation.

## What Belongs Here

- Cold first-online enrollment and automation reconciliation without a preparatory offline Install.
- First-attempt output, exit status, redacted Gateway evidence, and the packed Agent System source revision before any repeat.
- Successful repeat retaining the command job and dispatch credential without creating the skipped prompt job.

## What Does Not Belong Here

- Offline enrollment recovery, consent refusal, and device-only restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Gateway-free installation: [OS install](../os-install/README.md). Automation execution: [automations](../openclaw-automation-command/README.md).

## Notes

- This needs a separate fresh runner because dispatch identity is Gateway-wide; successful online enrollment would invalidate the missing-credential and offline-first conditions in the recovery example. The existing OS matrix gains one scenario on each OS, not another runtime or model matrix.
- Reuse the enrollment example's synthetic GitHub provider. Enrollment and native storage remain real; neither hosted credentials nor a model turn is needed. The command job stays disabled; the prompt job is skipped until model authentication is configured.
- The agent declares a Codex model without configuring a provider account. Cold Install must skip the unauthenticated prompt job while installing the command job. Model execution belongs to the automation scenarios.
- The first Install result must itself report a model-unavailable or missing-auth skip; a later inspection cannot substitute for that decision. Reconciliation can acquire native catalog evidence when prepared availability is unknown. Inspection remains passive. Unknown model availability gets at most four catalog refreshes with 250 ms, one-second, and three-second backoff. If still unknown, Install defers new prompt jobs with `automation-model-readiness-unresolved`, not a missing-auth claim. A Gateway `UNAVAILABLE` error remains an error. This credential-free scenario still requires definitive missing-auth or unavailable evidence; unresolved readiness does not pass its assertions. Explicit retryable reads get one native-hinted retry. The released Gateway’s exact stale-instance rejection from `sessions.resolve` additionally permits read-only recovery for up to 60 seconds, with exponential backoff capped at five seconds and RPC time charged to the budget. Cancellation or another rejection stops recovery; scheduler and session writes are never replayed. Model and session-resolution reads reuse enrollment’s bounded local Gateway readiness checks before dispatch; remote/TLS targets retain native transport behavior. This observes an in-progress reload without requesting another one.
- Setup, first Install, and dependent convergence checks share one fail-fast block. A missing prerequisite or failed first Install ends that journey; no shell retry can turn it green or create misleading downstream failures.
- Session creation uses the shared 120-second budget, subject to earlier cancellation or enclosing deadlines; unrelated requests retain their native timeout. Controlled-time source tests prove the budget, while this scenario proves installed behavior. First-attempt failures remain fatal.
- Enrollment allows up to 90 seconds for startup or plugin reload, within a 135-second connection deadline including authentication. Terminal reload failure and cancellation stop earlier. Session-creation failures report the automation ID and a safe native reason category; `unclassified` means the native rejection is not yet recognized, not that a timeout occurred.
- In CI, the first Install enables bounded, redacted native rejection evidence with `OPENCLAW_DEBUG=1`; it retains no request payload or arbitrary error details.
- Evidence is saved beneath `TMPDIR` before a repeat can change state. A Gateway log observation alone does not establish the failure's cause.
- Cold-install diagnostics enable native plugin-lifecycle tracing and a temporary Gateway-only Node loader hook for unavailable-instance stacks and reload start/publication/completion timestamps. The hook instruments the pinned upstream modules in memory, never installed files; unmatched instrumentation fails explicitly. It adds logging overhead, so timing is diagnostic, not an uninstrumented benchmark. Stack capture excludes error messages and request data; output still passes through the shared redactor. On failure, preserve the Gateway evidence before a read-only selected-model snapshot; that later snapshot is not the exact model evidence observed by Install. A failed session resolution gets one read-only probe after 60 seconds, before the model snapshot, using the unique materializing thread’s saved key; missing or ambiguous targets are reported rather than guessed. This reconstructs the key lookup, not a captured wire request. No reload, restart, or repeat Install occurs during the wait. Diagnostic failure never replaces the original Install exit status.

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
openclaw config set cron.enabled false --strict-json
export OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1
trace_node_options=$(printenv NODE_OPTIONS || true)
NODE_OPTIONS="$trace_node_options --import=$GITHUB_WORKSPACE/scripts/plugin-lifetime-trace.mjs" openclaw-gateway start
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
cd "$GITHUB_WORKSPACE/examples/os-install-online"
first_status=0
date -u +%Y-%m-%dT%H:%M:%SZ >"$TMPDIR/online-first.started"
OPENCLAW_DEBUG=1 openclaw agent-system install --yes --json >"$TMPDIR/online-first.json" 2>"$TMPDIR/online-first.stderr" || first_status=$?
date -u +%Y-%m-%dT%H:%M:%SZ >"$TMPDIR/online-first.finished"
printf '%s\n' "$first_status" >"$TMPDIR/online-first.exit"
cat "$TMPDIR/online-first.json" "$TMPDIR/online-first.stderr"
if ! tail -n 300 "$gateway_log" | node "$gateway_redactor" >"$TMPDIR/online-first.gateway.log"; then printf '%s\n' 'gateway evidence unavailable' >"$TMPDIR/online-first.gateway.log"; fi
if test "$first_status" -ne 0; then
  cat "$TMPDIR/online-first.gateway.log"
  if ! node "$gateway_redactor" < "$gateway_log" | grep -E 'agent-system:lifetime|plugins:lifecycle|reload|Plugin replacement applied|generation|PluginInstanceUnavailable|session-events|state/lease' | tail -n 200 | tail -c 32768 >"$TMPDIR/online-first.lifecycle.log"; then printf '%s\n' 'lifecycle evidence incomplete' >&2; fi
  cat "$TMPDIR/online-first.lifecycle.log"
  if ! node "$gateway_redactor" < "$gateway_log" | grep -F '[agent-system:lifetime]' | tail -n 80 | tail -c 32768; then printf '%s\n' 'lifetime evidence unavailable' >&2; fi
  printf 'first install started/finished (UTC):\n'
  cat "$TMPDIR/online-first.started" "$TMPDIR/online-first.finished"
  if jq -e '.blocked.automationGatewayDiagnostic.method == "sessions.resolve"' "$TMPDIR/online-first.json" >/dev/null; then
    if find "$SETUP_OPENCLAW_STATE_DIR" -type f -name 'automation-threads-*.json' -exec cat {} \; | jq -ecs '[.[].records[] | select(.phase == "materializing" and (.nativeId | type == "string")) | select(.nativeId | startswith("agent:install-data:automation:"))] | if length == 1 then {key: .[0].nativeId, agentId: "install-data", allowMissing: true} else error("expected one pending fixture thread") end' >"$TMPDIR/online-delayed-resolve.params.json"; then
      printf 'diagnostic wait starts (UTC): '
      date -u +%Y-%m-%dT%H:%M:%SZ
      sleep 60
      printf 'delayed sessions.resolve starts (UTC): '
      date -u +%Y-%m-%dT%H:%M:%SZ
      probe_status=0
      timeout --signal=TERM --kill-after=5 30 openclaw gateway call sessions.resolve --params "$(cat "$TMPDIR/online-delayed-resolve.params.json")" --timeout 15000 --json >"$TMPDIR/online-delayed-resolve.stdout" 2>"$TMPDIR/online-delayed-resolve.stderr" || probe_status=$?
      printf 'delayed sessions.resolve exit: %s; finished (UTC): ' "$probe_status"
      date -u +%Y-%m-%dT%H:%M:%SZ
      node "$gateway_redactor" < "$TMPDIR/online-delayed-resolve.stdout" | tail -c 4096 || true
      node "$gateway_redactor" < "$TMPDIR/online-delayed-resolve.stderr" | tail -c 4096 || true
      if ! node "$gateway_redactor" < "$gateway_log" | grep -E 'agent-system:lifetime|reload|Plugin replacement applied|generation|PluginInstanceUnavailable|session-events' | tail -n 60 | tail -c 16384; then printf '%s\n' 'post-wait reload evidence unavailable' >&2; fi
    else
      printf '%s\n' 'delayed session probe unavailable: no unique pending fixture thread' >&2
    fi
  fi
  printf '%s\n' 'selected-model snapshot after failed install (not the original preflight response)'
  if timeout --signal=TERM --kill-after=5 30 openclaw gateway call models.list --params '{"agentId":"install-data","view":"all","preparedOnly":true,"includeDefaultModels":false}' --timeout 15000 --json >"$TMPDIR/online-models.raw.json" 2>"$TMPDIR/online-models.stderr"; then
    if ! jq '{models: [.models[] | select(.provider == "openai" and .id == "gpt-6.1-sol") | {provider, id, available, unavailableReason, agentRuntime, tags}]}' "$TMPDIR/online-models.raw.json" | node "$gateway_redactor" >"$TMPDIR/online-models.json"; then printf '%s\n' 'selected-model evidence unavailable' >&2; fi
    cat "$TMPDIR/online-models.json"
  else
    model_status=$?
    printf 'selected-model request failed: exit %s\n' "$model_status" >&2
    node "$gateway_redactor" < "$TMPDIR/online-models.stderr" | tail -c 4096 || true
  fi
  exit "$first_status"
fi
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and any(.outcomes[]; .component == "automations" and .stepId == "github-issue-assignment" and .status == "skipped" and (.code == "automation-model-auth-missing" or .code == "automation-model-unavailable")) and all(.warnings[]; .code != "automation-sync-deferred")' "$TMPDIR/online-first.json"
before_status=0
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-before.json" || before_status=$?
if test "$before_status" -ne 1 || ! jq -e '.status == "attention" and ([.findings[] | select(.status != "healthy" and .status != "skipped") | {stepId, status, code}] == [{stepId: "scheduler", status: "blocked", code: "automation-scheduler-disabled"}]) and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and any(.jobs[]; .id == "cold-install-command" and .nativeEnabled == false and .nativeId != null) and any(.jobs[]; .id == "github-issue-assignment" and .nativeId == null and any(.findings[]; .status == "skipped" and (.code == "automation-model-auth-missing" or .code == "automation-model-unavailable")))' "$TMPDIR/online-jobs-before.json"; then
  printf 'automation list before repeat install exited %s\n' "$before_status" >&2
  jq '{status, jobs: [.jobs[] | {id, nativeEnabled}], findings: [.findings[] | {stepId, status, code}]}' "$TMPDIR/online-jobs-before.json" >&2
  exit 1
fi
openclaw agent-system install --non-interactive --json >"$TMPDIR/online-repeat.json" 2>"$TMPDIR/online-repeat.stderr"
cat "$TMPDIR/online-repeat.json" "$TMPDIR/online-repeat.stderr"
jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged") and all(.outcomes[]; .component != "automations" or .status == "unchanged" or (.status == "skipped" and (.code == "automation-model-auth-missing" or .code == "automation-model-unavailable")))' "$TMPDIR/online-repeat.json"
after_status=0
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-after.json" || after_status=$?
if test "$after_status" -ne 1 || ! jq -e '.status == "attention" and ([.findings[] | select(.status != "healthy" and .status != "skipped") | {stepId, status, code}] == [{stepId: "scheduler", status: "blocked", code: "automation-scheduler-disabled"}]) and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and any(.jobs[]; .id == "cold-install-command" and .nativeEnabled == false and .nativeId != null) and any(.jobs[]; .id == "github-issue-assignment" and .nativeId == null and any(.findings[]; .status == "skipped" and (.code == "automation-model-auth-missing" or .code == "automation-model-unavailable")))' "$TMPDIR/online-jobs-after.json"; then
  printf 'automation list after repeat install exited %s\n' "$after_status" >&2
  jq '{status, jobs: [.jobs[] | {id, nativeEnabled}], findings: [.findings[] | {stepId, status, code}]}' "$TMPDIR/online-jobs-after.json" >&2
  exit 1
fi
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-before.json" >"$TMPDIR/online-identities-before.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-after.json" | diff - "$TMPDIR/online-identities-before.json"
```
