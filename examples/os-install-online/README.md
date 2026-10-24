# Cold Online Install Example

Start the Gateway before the workspace's first Install, enroll dispatch, activate intake, and reconcile declared and derived automations on macOS and Ubuntu. Preserve the first attempt before checking successful convergence.

## What Belongs Here

- Cold first-online enrollment and automation reconciliation without a preparatory offline Install.
- First-attempt output, exit status, redacted Gateway evidence, and the packed Agent System source revision before any repeat.
- Successful repeat retaining the same native jobs and dispatch credential.

## What Does Not Belong Here

- Offline enrollment recovery, consent refusal, and device-only restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Gateway-free installation: [OS install](../os-install/README.md). Automation execution: [automations](../openclaw-automations/README.md).

## Notes

- This needs a separate fresh runner because dispatch identity is Gateway-wide; successful online enrollment would invalidate the missing-credential and offline-first conditions in the recovery example. The existing OS matrix gains one scenario on each OS, not another runtime or model matrix.
- Reuse the enrollment example's synthetic GitHub provider. Enrollment and native storage remain real; neither hosted credentials nor a model turn is needed. Both jobs stay disabled.
- Setup, first Install, and dependent convergence checks share one fail-fast block. A missing prerequisite or failed first Install ends that journey; no shell retry can turn it green or create misleading downstream failures.
- Automation Gateway requests use the native CLI timeout; first-attempt failures remain fatal.
- First-attempt evidence is redacted and bounded beneath `TMPDIR/install-evidence`, then uploaded as an `install-evidence-*` CI artifact before runner disposal. It includes the original exit status, install timing/output, native version, source revision, and console/structured Gateway logs before any repeat.
- Native debug logs retain available storage errors, causes, and lifecycle activity. Session-create phase logs require a completed call of at least one second; an immediate rejection may have no phase record. The shared session-access error does not identify its internal guard, and nearby lifecycle activity alone does not prove causation.

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
openclaw config set logging.file "$TMPDIR/install-native.log"
openclaw config set logging.level debug
openclaw config set diagnostics.enabled true --strict-json
OPENCLAW_LOG_LEVEL=debug OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1 openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/os-install-online"
first_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
first_status=0
openclaw agent-system install --yes --json >"$TMPDIR/online-first.json" 2>"$TMPDIR/online-first.stderr" || first_status=$?
printf '%s\n' "$first_status" >"$TMPDIR/online-first.exit"
cat "$TMPDIR/online-first.json" "$TMPDIR/online-first.stderr"
node --import tsx "$GITHUB_WORKSPACE/scripts/install-evidence.ts" online-first "$first_status" "$first_started" "$TMPDIR/online-first.json" "$TMPDIR/online-first.stderr" "$TMPDIR/install-native.log" || printf '%s\n' 'install evidence capture unavailable' >&2
if test "$first_status" -ne 0; then exit "$first_status"; fi
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and all(.warnings[]; .code != "automation-sync-deferred")' "$TMPDIR/online-first.json"
openclaw agent-system automations list --json | tee "$TMPDIR/online-jobs-before.json" | jq -e '.status == "aligned" and ([.jobs[].id] | sort) == ["cold-install-command", "github-issue-assignment"] and all(.jobs[]; .nativeEnabled == false)'
openclaw agent-system install --non-interactive --json >"$TMPDIR/online-repeat.json"
jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged") and all(.outcomes[]; .component != "automations" or .status == "unchanged")' "$TMPDIR/online-repeat.json"
openclaw agent-system automations list --json >"$TMPDIR/online-jobs-after.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-before.json" >"$TMPDIR/online-identities-before.json"
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/online-jobs-after.json" | diff - "$TMPDIR/online-identities-before.json"
```
