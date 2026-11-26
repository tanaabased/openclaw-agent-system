import openClawDispatchTrigger from './openclaw-dispatch-trigger.ts';
import automationModels from './automation-models.ts';
import codexDispatchHandoff from '../tasks/dispatch/codex-dispatch-handoff.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';

export const reviewAutomationId = 'github-review-request';

/** one native coordinator inherits the shared cadence; it never sends progress nudges. */
export default function reviewJobs(
  manifest: AgentManifest,
  runtime?: { entrypoint: string; pluginData: string },
  adapter: 'codex' | 'openclaw' = 'codex',
): ResolvedAutomation[] {
  const policy = manifest.github?.notifications;
  const settings = policy?.reviewRequest;
  if (!settings || !policy?.runtimes.includes(adapter)) return [];
  return automationModels(
    [
      {
        id: reviewAutomationId,
        origin: 'builtin',
        displayName: '🔎 REVIEW REQUESTS',
        enabled: !settings.paused,
        runtimes: [adapter],
        schedule: { kind: 'every', missedRun: 'native', seconds: policy.intervalMinutes * 60 },
        thread: { name: 'REVIEW REQUESTS' },
        model: settings.model ?? (manifest.models?.low ? 'low' : 'default'),
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
        overrides: {},
        ...(adapter === 'openclaw'
          ? {
              internalOpenClaw: {
                toolsAllow: ['*'],
                trigger: {
                  script: openClawDispatchTrigger({ action: 'review', operation: 'check' }),
                },
              },
            }
          : {}),
        payload: {
          kind: 'prompt',
          prompt:
            adapter === 'openclaw'
              ? 'Use agent_system_dispatch action review. Call scan, then next. For routing-required assess the returned PR evidence using the shared rubric and call prepare with target, assessment and title. Creation and source delivery are native operations handled by the tool. Never create chats or send messages yourself. Continue next for unrelated eligible work after a delivered input. Stop on unchanged, pending, uncertainty, denial or capacity; report provider failures, never report waiting as progress.'
              : [
                  'Observe authorized individual GitHub review requests through dispatch review scan. Retain pending requests while CI runs without comments, reviewer turns, pushes or reruns. Settled failed CI is eligible for review. Provider failures are failures, not no-change results. Native scheduler pause and approval denials remain binding.',
                  'Use native list_projects and list_threads before dispatch review next. For routing-required, read its PR and bounded diff and assess with the returned shared rubric. Call dispatch review prepare with its target, a concise title and assessment. No copied IDs, authority, inventory or workspace arguments. Explicit model overrides belong only to operator launches.',
                  'On prepared, evidence-prepared or retirement-prepared, execute the exact returned nativeHandoff once. Reconcile the same target afterward when supplied, including uncertain creation or evidence delivery. Never reconstruct or repeat native requests. On uncertain or denied stop that action; do not nudge or recreate the chat. Continue next only when the runtime permits it. Existing chats own substantive review and publication; do not relay their reasoning or repair code.',
                  'After review work, run feedback next through the same command block. The existing source-bound feedback owner selects only reviewer conversations for this native coordinator. Execute its exact handoff and use feedback reconcile; never broadcast a comment to both reviewer and author chats.',
                  'Use the shared command block with runtimeRoute:"dispatch" and runtimeInput:{action:"review",operation:"scan"|"next"|"prepare"|"reconcile",...authoredChoices}. Unchanged and CI-waiting results are quiet; no keep-going messages. Report only verified creations and actionable obstacles, not initial waiting.',
                  ...(runtime ? [codexDispatchHandoff(runtime)] : []),
                ].join('\n\n'),
        },
      },
    ],
    manifest.models,
    adapter,
  );
}
