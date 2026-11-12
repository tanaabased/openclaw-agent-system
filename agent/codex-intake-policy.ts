import automationModels from './automation-models.ts';
import issuePickupJobs, { issuePickupAutomationId } from './issue-pickup-jobs.ts';
import { issueChatTitleGuidance } from './tasks/dispatch/issue-chat-title.ts';
import { taskUpdateConsent } from './tasks/feedback/task-update-instructions.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import codexDispatchHandoff from './tasks/dispatch/codex-dispatch-handoff.ts';
import { codexQuietHeartbeatInstructions } from './codex-heartbeat.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

export const intakeAutomationId = 'github-issue-assignment';

/** Scheduling is independent of admission and retained workflow authority. */
export function codexIntakePolicy(manifest: AgentManifest) {
  return assignmentIntakePolicy(manifest, 'codex');
}

/** desired policy adds one reserved job; the native planner still owns every mutation. */
export function codexIntakeJobs(
  manifest: AgentManifest,
  runtime?: { entrypoint: string; pluginData: string },
): ResolvedAutomation[] {
  const declarations = manifest.automations ?? [];
  if (declarations.some((job) => [intakeAutomationId, issuePickupAutomationId].includes(job.id)))
    throw new IntakeError('intake-automation-id-reserved');
  const jobs = automationModels(declarations, manifest.models, 'codex');
  const selected = codexIntakePolicy(manifest);
  if (!selected) return jobs;
  const settings = selected.policy.issueAssignment!;
  if (settings.model === undefined && !manifest.models?.low)
    throw new IntakeError('intake-low-profile-required');
  return [
    ...jobs,
    ...automationModels(
      [
        {
          id: intakeAutomationId,
          displayName: '📥 ISSUE ASSIGNMENTS',
          enabled: !selected.policy.issueAssignment!.paused,
          runtimes: ['codex'],
          schedule: {
            kind: 'every',
            missedRun: 'native',
            seconds: selected.policy.intervalMinutes * 60,
          },
          thread: { name: 'ISSUE ASSIGNMENTS' },
          model: settings.model ?? 'low',
          ...(settings.effort === undefined ? {} : { effort: settings.effort }),
          overrides: {},
          payload: {
            kind: 'prompt',
            prompt: [
              taskUpdateConsent,
              issueChatTitleGuidance,
              'Retirement cleanup: activating this workflow authorizes native archival of its obsolete, idle, unpinned issue chats after the configured grace period and preservation checks. On retirement-prepared, execute its returned nativeHandoff exactly once in a separate functions.exec call. It contains the exact prepared request; never transcribe or reconstruct its threadId, hostId, or archived fields. If retained evidence is unavailable after compaction, use dispatch next to reconcile and obtain a fresh prepared request. Continue dispatch next to reconcile native archival and worktree reclamation. Native denial stops the action; uncertain results are reconciled without repeating the archive. On retirement-inventory-required, refresh native list_threads, then call next with no inventory fields; the runtime reads its native result. Never remove a Codex worktree yourself; the desktop owns snapshots and reclamation. Count archive requests within the twelve-action occurrence budget.',
              'Read the current bound agent.yaml before each workflow decision. Live policy controls mode, approved authors, and recipients for every active issue. Scheduler pause stops future occurrences, not an accepted run or issue turn. Saved policy hashes are provenance, never authorization. Policy-held work stays pending and is reconsidered automatically; Install is needed only to reconcile installed automation machinery.',
              'Observe bounded incoming issue and feedback activity independently of dispatch eligibility. Dispatch only what the live manifest currently permits. Verified approved feedback is source-bound task direction, including explicit requests to enter implementation through the shared issue transition. Native denials, explicit cancellation, identity mismatches, and uncertain submissions retain their own stops.',
              'The shared scan block performs intake scan, dispatch observe-denials, and continuation next in order using the same fixed runtime paths. Do not issue those follow-up commands separately. Only a ready scan advances to denial observation, and only a ready denial observation advances to continuation. A blocked or failed step stops the sequence; obey its stop/report instruction. Continuation observes already-attempted requests and never prepares another send. After reconciled or idle, continue ordinary dispatch. Implementation and planning remain in native chat; missing plans, results, questions or presentations never create work or justify a nudge.',
              'Check GitHub for assigned issues and observe managed issue and PR comments. The live runtime selects eligible work and prepares its exact native chat/worktree or feedback request. On feedback-prepared, execute its returned nativeHandoff exactly once in a separate functions.exec call. It contains the complete prepared native send and needs no store/load step. Do not shorten it or reconstruct the prompt from the visible comment. If execution never started or its outcome is uncertain, use dispatch next to reconcile; never execute an old handoff again. The coordinator must not call feedback context: that belongs to the receiving issue chat. After the send, use the shared scheduled command block with runtimeRoute:"feedback" and runtimeInput:{action:"reconcile",source:<comment URL>}; the runtime resolves the original task and event even after an uncertain send. Then continue dispatch next for unrelated work. Repository preparation uses native host authorization and approved checkout locations; missing saved projects retain their exact manual registration handoff.',
              'Run the deterministic scan before any routine commentary or progress update, using the shared scheduled command block below with runtimeRoute:"intake" and runtimeInput:{action:"scan"}. Its command uses literal node from the configured host PATH, with the exact entrypoint and plugin-data from the newest trusted Agent System context, followed by scan --plugin-data and intakeRuntime.pluginData. If that context is unavailable, report the blocker; never guess a workspace or executable.',
              'Even when the scan is unchanged, use native list_projects and list_threads, then the shared scheduled command block with runtimeRoute:"dispatch" and runtimeInput:{action:"next"}; the runtime reads the native inventory results from this turn. Execute the block intact for every scan, next, prepare, reconcile, and report operation; do not replace it with a handwritten shell command or rebuild its paths. It owns bounded busy retries, the exact host-access retry, complete output collection, and complete structured responses. Do not replace it with an improvised retry loop. Never change permissions, delete locks, reset work, or bypass a native denial.',
              ...(runtime
                ? [
                    'Shared scheduled command block: in functions.exec prepend only const runtimeRoute = <intake, dispatch, continuation, or feedback>; const runtimeInput = <the documented JSON request>. For intake scan use {action:"scan"}; for intake failure-response include action:"failure-response". Require the fixed entrypoint and plugin-data below to match the newest trusted context; node is resolved from the configured host PATH at execution, not a saved executable path. Resume a running cell with functions.wait; never launch a second copy. Inspect the completed output before choosing the next operation. This block cannot create chats or send turns. On codex-node-unavailable or codex-node-version-unsupported, report its actionable diagnostic and stop without calling the unavailable failure formatter. If orchestration is unavailable, stop with an actionable blocker.',
                    codexDispatchHandoff(runtime),
                    'For routing-required, assess the returned bounded evidence against its routing rubric, preserve verified metadata and label content assessment. Use the shared block with runtimeRoute:"dispatch" and runtimeInput:{action:"prepare",target,title,assessment}. Unset complexity selects the configured default automatically; fallback:"default" is only needed to select default when work tiers are omitted. Use the returned issue target URL; the runtime resolves its owned task and verifies the current preparation. Never provide id or digest. The runtime selects the exact model and effort; do not supply model overrides or call routingRuntime separately.',
                    'Only after dispatch prepare returns prepared, execute its returned nativeHandoff exactly once in a separate functions.exec call. It carries the exact request without a separate store/load step. This is native chat/worktree creation under the activated assignment schedule, separately reviewed from host access. A historical one-issue recovery does not limit unrelated eligible assignments; current operator restrictions and native denials remain authoritative. If creation is uncertain, reconcile without creating again.',
                  ]
                : [
                    'For routing-required, assess its bounded routing context, and prepare with target set to its issue URL, title and assessment. The runtime resolves the task and preparation fingerprint; never supply id or digest. Native creation is a separate action and requires the exact prepared request. Missing installed runtime identity requires Install reconciliation before scheduled orchestration.',
                  ]),
              'After create_thread, reconcile with the same issue target URL. The runtime reads the native creation receipt; do not supply an id or receipt. If creation fails or its outcome is unknown, reconcile the same target; never repeat create_thread.',
              'The runtime counts up to twelve dispatch actions per native occurrence (next, prepare, and reconcile each count). After a successful launch/reconcile or retained pending creation, call next again while budget remains. Do not end the occurrence merely because one issue was launched or completed. The shared command block retries busy results at most three times; if it stays busy, use failure-response with private-state-file-lock-busy. Busy attempts do not consume the runtime action budget; a child may briefly hold the journal while verifying context or saving its result. On an item failure with nextAction next, preserve its request and continue next for unrelated work. Stop on idle, at-capacity, budget-exhausted, required approval, or a failed tool call without that instruction. Do not wait for child assessments to finish. Call report after the loop, outside this twelve-action budget. Once creation is verified, the individual issue owns its assessment and all later progress. Do not inspect assessments or relay their plans, questions, blockers, or handoffs in intake. Do not resend assessment prompts, change models, create replacement chats, clone repositories outside the trusted dispatch runtime, register projects through unsupported actions, or edit scheduler files. The child assessment stays in its native conversation; formatting a result does not persist a plan or establish completion.',
              codexQuietHeartbeatInstructions +
                ' On dispatch-scan-required, perform the scan and retry. Use the shared command block for report retries; after exhausted busy retries, use failure-response. Use one final heartbeat, including nothing-new checks; never append separate cards or assessment commentary. The runtime records reporting attempts, not delivery guarantees.',
              'After a failed runtime call, first follow the bounded exact-command host-access retry above when applicable. A native approval denial never authorizes repeating that action or using another route. For denied dispatch prepare or create_thread only, if native host authority permits further tracking, use the shared block with runtimeRoute:"dispatch" and runtimeInput:{action:"reconcile",target} without a receipt. Use the issue URL of the held operation; the runtime resolves its original receipt. If reconciliation returns nextAction next, continue unrelated eligible work and finish with the ordinary combined report. Otherwise stop the occurrence. The next permitted occurrence observes original native evidence before selecting work. Shared or ambiguous denials remain workflow stops. The operator must recover an exact item hold through retry-denied with its issue target and explicitly renewed authorization when required; time or reassignment does not clear it.',
              'If a failed runtime call remains unresolved, or the host does not permit further tracking after refusal, use intakeRuntime failure-response with automationId from this trigger and the stable returned code (codex-runtime-failed if none). It is a pure error formatter, not a quiet-success formatter, and does not need host state access. Copy its response verbatim once as the whole final answer. Only an explicit native approval rejection is native-approval-denied. A thread lookup, unavailable host, transport error, or generic failed tool call is not an approval rejection: report codex-runtime-failed with the actual bounded, redacted error and preserve pending retirement for reconciliation on the next scheduled run. Do not blindly repeat an archive whose outcome is uncertain; the issue-specific denial recovery above does not apply to retirement. For native rejection submit only {automationId,code:"native-approval-denied"}, then include the actual bounded, redacted rejection reason once inside its heartbeat message, or say unavailable. Never echo a raw command, prompt, or credential. Do not put prose in code, add unsupported fields, reuse an earlier code, or duplicate a card outside the envelope. Stop with pending work intact; a failed operation did not succeed.',
            ].join('\n\n'),
          },
        },
      ],
      manifest.models,
      'codex',
    ),
    ...issuePickupJobs(manifest, 'codex', runtime ? codexDispatchHandoff(runtime) : ''),
  ];
}
