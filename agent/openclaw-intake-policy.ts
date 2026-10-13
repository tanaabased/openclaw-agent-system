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
  if (!manifest.models?.low) throw new IntakeError('intake-low-profile-required');
  const model = projectRoutingProfile(manifest.models.low, 'openclaw');
  if (model.status !== 'mapped') throw new IntakeError(model.code);
  const message = [
    'Run the V2 assignment intake only. Call agent_system_intake with action scan and the policyDigest below before commentary. Report the returned scan counts or exact blocker in this automation conversation. Do not create issue chats, change issue status, assess issues, process GitHub comments, or publish anything. Intake records are admission evidence, not workflow completion.',
    `Policy digest: ${selected.digest}`,
    'Use only the invoking agent’s bound tools. Never choose another workspace, account, executable or credentials. A failed or incomplete scan is not an empty successful scan.',
  ].join('\n\n');
  const script = [
    'function unwrap(v){if(typeof v === "string")return unwrap(JSON.parse(v));if(v.output)return unwrap(v.output);if(v.content)return unwrap(v.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"));return v;}',
    'try {',
    `const r=unwrap(await agent_system_intake(${JSON.stringify({ action: 'check', policyDigest: selected.digest })}));`,
    'if (!r || !["ready","blocked"].includes(r.status) || typeof r.changed !== "boolean") throw new Error("intake-condition-invalid");',
    `json({fire:r.changed===true,message:${JSON.stringify(message)},state:{status:r.status,code:r.code??null}});`,
    '} catch { json({fire:true,message:"The read-only V2 intake condition failed. Do not dispatch work. Inspect agent_system_intake and report the bounded blocker; never treat a failed check as an empty successful scan.",state:{status:"blocked",code:"intake-condition-failed"}}); }',
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
        toolsAllow: ['agent_system_intake'],
        group: 'Agent System',
      },
    },
  ];
}
