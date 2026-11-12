import automationModels from './automation-models.ts';
import issuePickupJobs, { issuePickupAutomationId } from './issue-pickup-jobs.ts';
import { issueChatTitleGuidance } from './issue-chat-title.ts';
import { taskUpdateConsent } from './tasks/feedback/task-update-instructions.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';

export const openclawIntakeAutomationId = 'github-issue-assignment';

/** Derived declarations use the ordinary automation reconciler, never edit agent.yaml. */
export default function openclawIntakeJobs(manifest: AgentManifest): ResolvedAutomation[] {
  const declarations = manifest.automations ?? [];
  if (
    declarations.some((job) =>
      [openclawIntakeAutomationId, issuePickupAutomationId].includes(job.id),
    )
  )
    throw new IntakeError('intake-automation-id-reserved');
  const jobs = automationModels(declarations, manifest.models, 'openclaw');
  const selected = assignmentIntakePolicy(manifest, 'openclaw');
  if (!selected) return jobs;
  const settings = selected.policy.issueAssignment!;
  if (settings.model === undefined && !manifest.models?.default)
    throw new IntakeError('intake-default-profile-required');
  const message = [
    taskUpdateConsent,
    'Fill initially available intake slots in one bounded pass. Consume saved discoveries by iterating agent_system_dispatch action next; for discovery-progress, reproduce its presentation card and call next again. The runtime retains this native run’s fixed starting allowance and selects each issue or feedback owner at most once. For routing-required, read the linked issue and assess its bounded evidence using assessmentSchema; unset complexity selects the configured default automatically. Then call prepare with its issue target URL, assessment and title. The runtime resolves task IDs and preparation fingerprints internally; never supply id or digest. ' +
      issueChatTitleGuidance +
      ' Prepare resolves routing, prepares the managed worktree and creates the ordinary session internally using the retained credential. For assessment-required or session-created, call agent_system_dispatch action assess with that same target. The runtime sends one journaled assessment turn into the verified session. For reconcile-required, call action reconcile with its target; it reads the saved attempt and never repeats an uncertain send. If reconciliation returns session-created, call assess with that target. The condition saves bounded discovery progress; next consumes saved authorized feedback on retained issues and their linked delivery PRs, reconciles saved attempts, and delivers eligible feedback to its existing chat independently of assignment capacity, then selects eligible issue work using shared capacity. Feedback runs in the existing issue session; the coordinator never answers it. On an item failure with nextAction next, preserve its request and call next for unrelated work. Never replay a denied or uncertain operation. On uncertain without that instruction, stop. On implementation-pending, implementation-idle, policy-held, feedback-pending, feedback-completed, feedback-queued, assessment-pending or assessment-completed, call next to consider other work without waiting or polling. On pass-completed, idle, at-capacity, busy, or blocked without nextAction next, stop. A busy response means another dispatch operation owns the journal; preserve its diagnostic code, leave the recorded work untouched, and let a later scheduled run or explicit refresh observe progress. Do not poll or rescan in this run; quick completions never refill its allowance. Before stopping after any scan/dispatch outcome (except busy), call agent_system_dispatch action report and reproduce its response unchanged; an empty response means no card. Do not announce assessment outcomes in intake; configured settings are not proof of execution. Native chat owns plans, questions and implementation. Missing optional results, idle chats and mode edits never authorize an implementation or Auto-decision nudge. Do not call chat.send directly, reconstruct a message, submit an assessment result for the issue session, spawn a child, change session settings, perform the full task investigation in the coordinator, implement, publish, or answer GitHub comments in this coordinator.',
    'Tool transport: a native tool result may be a JSON string. Decode it before reading status or id, including after store/load. Invalid or incomplete responses are blockers. Never reconstruct a native session request; only agent_system_dispatch owns creation.',
    'Read the live bound agent.yaml for every dispatch and publication decision. Observe incoming activity independently of eligibility. Hold unsupported or disabled workflow effects without losing observations or stopping other supported work. Policy edits do not require Install; only installed automation changes do.',
    'Use only the invoking agent’s bound tools. Never choose another workspace, account, executable or credentials. A failed or incomplete scan is not an empty successful scan.',
  ].join('\n\n');
  const script = [
    'function unwrap(v){if(typeof v === "string")return unwrap(JSON.parse(v));if(v.output)return unwrap(v.output);if(v.content)return unwrap(v.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"));return v;}',
    'let stage="dispatch"; const started=Date.now();',
    'try {',
    'stage="dispatch";',
    'const d=unwrap(await agent_system_dispatch({action:"check"}));',
    'if (!d || d.status!=="ready" || typeof d.changed!=="boolean") throw new Error("dispatch-condition-invalid");',
    `json({fire:d.changed===true,message:(d.diagnostic ? "Intake check: "+JSON.stringify(d.diagnostic)+". " : "")+${JSON.stringify(message)},state:{status:d.status,outcome:d.outcome,more:d.more,code:d.code,diagnostic:d.diagnostic}});`,
    '} catch (error) { const code=[error?.code,error?.message].find(value=>typeof value==="string" && /^(?:intake|dispatch|feedback|continuation|github|automation|private-state)-[a-z0-9-]{1,100}$/.test(value))??stage+"-condition-failed"; json({fire:true,message:"The "+stage+" condition failed ("+code+") after "+Math.max(0,Date.now()-started)+" ms. This pass could not complete. Inspect agent_system_intake and agent_system_dispatch with discovery checks and report the bounded blocker; never treat a failed check as an empty successful scan.",state:{status:code.endsWith("-busy")?"busy":"failed",stage,code,diagnostic:{phase:stage,elapsedMs:Math.max(0,Date.now()-started),reason:["AbortError","TimeoutError","TypeError","SyntaxError"].includes(error?.name)?error.name:code}}}); }',
  ].join('\n');
  return [
    ...jobs,
    ...automationModels(
      [
        {
          id: openclawIntakeAutomationId,
          origin: 'builtin',
          displayName: '📥 ISSUE ASSIGNMENTS',
          enabled: !selected.policy.issueAssignment!.paused,
          runtimes: ['openclaw'],
          schedule: {
            kind: 'every',
            seconds: selected.policy.intervalMinutes * 60,
            missedRun: 'native',
          },
          thread: { name: 'ISSUE ASSIGNMENTS' },
          model: settings.model ?? 'default',
          ...(settings.effort === undefined ? {} : { effort: settings.effort }),
          overrides: {},
          payload: { kind: 'prompt', prompt: message },
          internalOpenClaw: {
            trigger: { script },
            // retain the owning agent's tools; host policy and denials still apply.
            toolsAllow: ['*'],
          },
        },
      ],
      manifest.models,
      'openclaw',
    ),
    ...issuePickupJobs(manifest, 'openclaw'),
  ];
}
