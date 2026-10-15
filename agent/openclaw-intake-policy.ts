import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { projectRoutingProfile } from './model-routing.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';

export const openclawIntakeAutomationId = 'github-issue-assignment';

/** Derived declarations use the ordinary automation reconciler, never edit agent.yaml. */
export default function openclawIntakeJobs(manifest: AgentManifest): ResolvedAutomation[] {
  const jobs = manifest.automations ?? [];
  if (jobs.some((job) => job.id === openclawIntakeAutomationId))
    throw new IntakeError('intake-automation-id-reserved');
  const selected = assignmentIntakePolicy(manifest, 'openclaw');
  if (!selected) return jobs;
  if (!manifest.models?.default) throw new IntakeError('intake-default-profile-required');
  const model = projectRoutingProfile(manifest.models.default, 'openclaw');
  if (model.status !== 'mapped') throw new IntakeError(model.code);
  const message = [
    'Advance at most one issue per run. First call agent_system_intake with action scan and the policyDigest below. If blocked, report the blocker and stop. Then call agent_system_dispatch action next. For routing-required, classify only the returned bounded evidence using assessmentSchema and call prepare with its id, digest, assessment and a concise plain ASCII title. Prepare resolves routing, prepares the managed worktree and creates the ordinary session internally using the retained credential. For assessment-required or session-created, call agent_system_dispatch action assess with that same id. The runtime sends one journaled assessment turn into the verified session, preserving any completed investigation. For reconcile-required, call action reconcile with its id; it reads the saved attempt and never repeats an uncertain send. If reconciliation returns session-created or working-turn-completed, call assess with that id. On assessment-pending, assessment-completed, working-turn-pending, idle, at-capacity, or blocked, stop. Do not poll in this run. Report the session and retained outcome or exact blocker; configured settings are not proof of execution. Only a recorded plan-ready result establishes a ready plan. Do not call chat.send directly, reconstruct a message, submit an assessment result for the issue session, spawn a child, change session settings, investigate in the coordinator, implement, publish, or process GitHub comments.',
    'Tool transport: a native tool result may be a JSON string. Decode it before reading status or id, including after store/load. Invalid or incomplete responses are blockers. Never reconstruct a native session request; only agent_system_dispatch owns creation.',
    `Policy digest: ${selected.digest}`,
    'Use only the invoking agent’s bound tools. Never choose another workspace, account, executable or credentials. A failed or incomplete scan is not an empty successful scan.',
  ].join('\n\n');
  const script = [
    'const diagnostics=["intake-condition-invalid","dispatch-condition-invalid","dispatch-native-caller-unavailable","dispatch-agent-required","dispatch-manifest-unavailable","dispatch-intake-activation-required","dispatch-plan-mode-required"];',
    'function unwrap(v){if(typeof v === "string")return unwrap(JSON.parse(v));if(v.output)return unwrap(v.output);if(v.content)return unwrap(v.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"));return v;}',
    'let stage="intake";',
    'try {',
    `const r=unwrap(await agent_system_intake(${JSON.stringify({ action: 'check', policyDigest: selected.digest })}));`,
    'if (!r || !["ready","blocked"].includes(r.status) || typeof r.changed !== "boolean") throw new Error("intake-condition-invalid");',
    'stage="dispatch";',
    'const d=r.status==="ready"?unwrap(await agent_system_dispatch({action:"check"})):{status:"ready",changed:false};',
    'if (!d || d.status!=="ready" || typeof d.changed!=="boolean") throw new Error("dispatch-condition-invalid");',
    `json({fire:r.changed===true||d.changed===true,message:${JSON.stringify(message)},state:{status:r.status,code:r.code??null}});`,
    '} catch (error) { const code=[error?.code,error?.message].find(value=>diagnostics.includes(value))??stage+"-condition-failed"; json({fire:true,message:"The read-only "+stage+" condition failed ("+code+"). Do not dispatch work. Inspect agent_system_intake and agent_system_dispatch with read-only checks and report the bounded blocker; never treat a failed check as an empty successful scan.",state:{status:"blocked",stage,code}}); }',
  ].join('\n');
  return [
    ...jobs,
    {
      id: openclawIntakeAutomationId,
      enabled: true,
      runtimes: ['openclaw'],
      schedule: {
        kind: 'every',
        seconds: selected.policy.intervalMinutes * 60,
        missedRun: 'native',
      },
      thread: { name: 'ISSUE ASSIGNMENTS' },
      overrides: { openclaw: { model: model.model, effort: model.thinking } },
      payload: { kind: 'prompt', prompt: message },
      internalOpenClaw: {
        trigger: { script },
        // retain the owning agent's tools; host policy and denials still apply.
        toolsAllow: ['*'],
        group: 'Agent System',
      },
    },
  ];
}
