import { assessmentSummaryConsent } from './assessment-summary-state.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import workflowPaused from '../channels/github/workflow-paused.ts';
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
    assessmentSummaryConsent,
    'Fill initially available intake slots in one bounded pass. Consume saved discoveries by iterating agent_system_dispatch action next; for discovery-progress, reproduce its presentation card and call next again. The runtime retains this native run’s fixed starting allowance and selects each issue or feedback owner at most once. For routing-required, classify only the returned bounded evidence using assessmentSchema and call prepare with its id, digest, assessment and a concise plain ASCII title. Prepare resolves routing, prepares the managed worktree and creates the ordinary session internally using the retained credential. For assessment-required or session-created, call agent_system_dispatch action assess with that same id. The runtime sends one journaled assessment turn into the verified session, preserving any completed investigation. For reconcile-required, call action reconcile with its id; it reads the saved attempt and never repeats an uncertain send. If reconciliation returns session-created or working-turn-completed, call assess with that id. The condition saves bounded discovery progress; next consumes saved authorized feedback on retained issues and their linked delivery PRs, reconciles saved attempts, and selects the oldest eligible assignment or feedback using shared capacity. Feedback runs in the existing issue session; the coordinator never answers it. On claim-waiting, call next; ownership selection requires a later native intake run, never another prepare call in this run. On an item failure with nextAction next, preserve its request and call next for unrelated work. Never replay a denied or uncertain operation. On uncertain without that instruction, stop. On implementation-pending, implementation-completed, implementation-queued, implementation-idle, policy-held, feedback-pending, feedback-completed, feedback-queued, assessment-pending, assessment-completed or working-turn-pending, call next to consider other work without waiting or polling. On working-turn-completed, call assess with that same id, then continue next. On pass-completed, idle, at-capacity, busy, or blocked without nextAction next, stop. A busy response means another dispatch operation owns the journal; preserve its diagnostic code, leave the recorded work untouched, and let a later scheduled run or explicit refresh observe progress. Do not poll or rescan in this run; quick completions never refill its allowance. Before stopping after any scan/dispatch outcome (except busy), call agent_system_dispatch action report and reproduce its response unchanged; an empty response means no card. Do not announce assessment outcomes in intake; configured settings are not proof of execution. Only a recorded plan-ready result establishes a ready plan. Do not call chat.send directly, reconstruct a message, submit an assessment result for the issue session, spawn a child, change session settings, investigate in the coordinator, implement, publish, or answer GitHub comments in this coordinator.',
    'Tool transport: a native tool result may be a JSON string. Decode it before reading status or id, including after store/load. Invalid or incomplete responses are blockers. Never reconstruct a native session request; only agent_system_dispatch owns creation.',
    'Read the live bound agent.yaml for every dispatch and publication decision. Observe incoming activity independently of eligibility. Hold unsupported or disabled workflow effects without losing observations or stopping other supported work. Policy edits do not require Install; only installed automation changes do.',
    'Use only the invoking agent’s bound tools. Never choose another workspace, account, executable or credentials. A failed or incomplete scan is not an empty successful scan.',
  ].join('\n\n');
  const script = [
    'function unwrap(v){if(typeof v === "string")return unwrap(JSON.parse(v));if(v.output)return unwrap(v.output);if(v.content)return unwrap(v.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"));return v;}',
    'let stage="intake";',
    'try {',
    'stage="dispatch";',
    'const d=unwrap(await agent_system_dispatch({action:"check"}));',
    'if (!d || d.status!=="ready" || typeof d.changed!=="boolean") throw new Error("dispatch-condition-invalid");',
    `json({fire:d.changed===true,message:${JSON.stringify(message)},state:{status:d.status,outcome:d.outcome,more:d.more,code:d.code}});`,
    '} catch (error) { const code=[error?.code,error?.message].find(value=>typeof value==="string" && /^(?:intake|dispatch|feedback|continuation|github|automation|private-state)-[a-z0-9-]{1,100}$/.test(value))??stage+"-condition-failed"; json({fire:true,message:"The "+stage+" condition failed ("+code+"). This pass could not complete. Inspect agent_system_intake and agent_system_dispatch with discovery checks and report the bounded blocker; never treat a failed check as an empty successful scan.",state:{status:code.endsWith("-busy")?"busy":"failed",stage,code}}); }',
  ].join('\n');
  return [
    ...jobs,
    {
      id: openclawIntakeAutomationId,
      enabled: !workflowPaused(selected.policy.issueAssignment!),
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
