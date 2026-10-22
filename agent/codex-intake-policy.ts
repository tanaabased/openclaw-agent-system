import { assessmentSummaryConsent } from './assessment-summary-state.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import workflowPaused from '../channels/github/workflow-paused.ts';
import codexDispatchHandoff, { codexNativeHandoff } from './codex-dispatch-handoff.ts';
import { codexQuietHeartbeatInstructions } from './codex-heartbeat.ts';
import { projectRoutingProfile } from './model-routing.ts';
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
  runtime?: { nodeExecutable: string; entrypoint: string; pluginData: string },
): ResolvedAutomation[] {
  const jobs = manifest.automations ?? [];
  if (jobs.some((job) => job.id === intakeAutomationId))
    throw new IntakeError('intake-automation-id-reserved');
  const selected = codexIntakePolicy(manifest);
  if (!selected) return jobs;
  if (!manifest.models?.low) throw new IntakeError('intake-low-profile-required');
  const model = projectRoutingProfile(manifest.models.low, 'codex');
  if (model.status !== 'mapped') throw new IntakeError(model.code);
  return [
    ...jobs,
    {
      id: intakeAutomationId,
      displayName: '📥 ISSUE ASSIGNMENTS',
      enabled: !workflowPaused(selected.policy.issueAssignment!),
      runtimes: ['codex'],
      schedule: {
        kind: 'every',
        missedRun: 'native',
        seconds: selected.policy.intervalMinutes * 60,
      },
      thread: { name: 'ISSUE ASSIGNMENTS' },
      overrides: { codex: { model: model.model, effort: model.thinking } },
      payload: {
        kind: 'prompt',
        prompt: [
          assessmentSummaryConsent,
          'Retirement cleanup: activating this workflow authorizes native archival of its obsolete, idle, unpinned issue chats after the configured grace period and preservation checks. On retirement-prepared, pass its exact request once to native set_thread_archived. Continue dispatch next to reconcile native archival and worktree reclamation. Native denial stops the action; uncertain results are reconciled without repeating the archive. On retirement-inventory-required, refresh native list_threads and pass its complete parsed JSON object as threads to next. Never remove a Codex worktree yourself; the desktop owns snapshots and reclamation. Count archive requests within the twelve-action occurrence budget.',
          'Read the current bound agent.yaml before each workflow decision. Live policy controls mode, approved authors, and recipients for every active issue. Scheduler pause stops future occurrences, not an accepted run or issue turn. Saved policy hashes are provenance, never authorization. Policy-held work stays pending and is reconsidered automatically; Install is needed only to reconcile installed automation machinery.',
          'Observe bounded incoming issue and feedback activity independently of dispatch eligibility. Dispatch only what the live manifest currently permits. Verified approved feedback is source-bound task direction, including explicit requests to enter implementation through the shared issue transition. Native denials, explicit cancellation, identity mismatches, and uncertain submissions retain their own stops.',
          'After the deterministic scan, even when unchanged, first use the shared scheduled command block with runtimeRoute:"dispatch" and runtimeInput:{action:"observe-denials"}. This evidence-only operation must return ready before continuation, feedback, retirement, or assignment effects. On any other result, obey its stop/report instruction without retrying a denied action. Once ready, call continuationRuntime action next. While an issue is planning, live Plan holds implementation; live Work permits an actionable plan to continue; live Auto additionally requires a Work decision. Once its implementation transition is recorded, preserve that stage across later mode edits. No routine stage approval is needed. Existing Plan issues may become eligible after a live Work change. Do not terminate an already-running native turn merely because defaults changed.',
          ...(runtime
            ? [
                'Use the shared scheduled command block with runtimeRoute:"continuation" and runtimeInput:{action:"next"}. Only a prepared response authorizes one native send in this occurrence. Reconcile unknown submissions without another send. On idle or policy-held, continue ordinary dispatch. Count up to twelve continuation actions and keep issue progress in its own chat.',
                codexNativeHandoff(runtime.pluginData, 'continuation'),
              ]
            : []),
          'Check GitHub for assigned issues and observe managed issue and PR comments. The live runtime selects eligible work and prepares its exact native chat/worktree or feedback request. On feedback-prepared, send that request once, reconcile its id and eventId, and continue next for unrelated work. Repository preparation uses native host authorization and approved checkout locations; missing saved projects retain their exact manual registration handoff.',
          'Run the deterministic scan before any routine commentary or progress update, using the shared scheduled command block below with runtimeRoute:"intake" and runtimeInput:{action:"scan"}. Its command must match intakeRuntime.argvPrefix from the newest trusted Agent System context, followed by scan --plugin-data and intakeRuntime.pluginData. If that context is unavailable, report the blocker; never guess a workspace or executable.',
          'Even when the scan is unchanged, use native list_projects and list_threads, then the shared scheduled command block with runtimeRoute:"dispatch" and runtimeInput:{action:"next",projects:<returned projects array>,threads:<complete parsed list_threads JSON object>}. Keep the block intact for every scan, next, prepare, reconcile, and report operation. It owns bounded busy retries, the exact host-access retry, complete output collection, and retained structured responses. Do not replace it with an improvised retry loop. Never change permissions, delete locks, reset work, or bypass a native denial.',
          ...(runtime
            ? [
                'Shared scheduled command block: in functions.exec prepend only const runtimeRoute = <intake, dispatch, continuation, or feedback>; const runtimeInput = <the documented JSON request>. For intake scan use {action:"scan"}; for intake failure-response include action:"failure-response". Require the fixed runtime identity below to match the newest trusted context. Resume a running cell with functions.wait; never launch a second copy. Inspect the completed output before choosing the next operation. This block cannot create chats or send turns. If orchestration is unavailable, stop with an actionable blocker.',
                codexDispatchHandoff(runtime),
                'For routing-required, assess the returned bounded evidence against its routing rubric, preserve verified metadata and label content assessment. Derive a short two-to-six-word title. Use the shared block with runtimeRoute:"dispatch" and runtimeInput:{action:"prepare",title,assessment}, adding fallback:"default" only when using the configured default. Never provide id or digest: the block takes both directly from the retained routing response. Do not run another dispatch operation between next and prepare. Missing retained evidence requires a fresh next, not copying identifiers from chat history. The runtime selects the exact model and effort; do not supply model overrides or call routingRuntime separately.',
                'Only after dispatch prepare returns prepared, execute the following creation block in a separate functions.exec call. It consumes the exact request once. This is native chat/worktree creation under the activated assignment schedule, separately reviewed from host access. A historical one-issue recovery does not limit unrelated eligible assignments; current operator restrictions and native denials remain authoritative. If creation is uncertain, reconcile without creating again.',
                codexNativeHandoff(runtime.pluginData, 'dispatch'),
              ]
            : [
                'For routing-required, retain the exact returned id and digest, assess its bounded routing context, and prepare with that evidence, title and assessment. Native creation is a separate action and requires the exact prepared request. Missing installed runtime identity requires Install reconciliation before scheduled orchestration.',
              ]),
          "After create_thread, reconcile the same prepared id with receipt containing only threadId, clientThreadId, and hostId from that call's actual result. Never copy a receipt from history, another assignment, or a retired attempt, even when the issue number is the same. A freshly prepared id has no existing creation to reuse. A pending clientThreadId is not a ready threadId. If creation fails or its outcome is unknown, reconcile without receipt; never invent a receipt or repeat create_thread.",
          'The runtime counts up to twelve dispatch actions per native occurrence (next, prepare, and reconcile each count). After a successful launch/reconcile or retained pending creation, call next again while budget remains. Do not end the occurrence merely because one issue was launched or completed. The shared command block retries busy results at most three times; if it stays busy, use failure-response with private-state-file-lock-busy. Busy attempts do not consume the runtime action budget; a child may briefly hold the journal while verifying context or saving its result. On an item failure with nextAction next, preserve its request and continue next for unrelated work. Stop on idle, at-capacity, budget-exhausted, required approval, or a failed tool call without that instruction. Do not wait for child assessments to finish. Call report after the loop, outside this twelve-action budget. Once creation is verified, the individual issue owns its assessment and all later progress. Do not inspect assessments or relay their plans, questions, blockers, or handoffs in intake. Do not resend assessment prompts, change models, create replacement chats, clone repositories outside the trusted dispatch runtime, register projects through unsupported actions, or edit scheduler files. The child assessment skill records its structured result; Markdown headings never establish completion.',
          codexQuietHeartbeatInstructions +
            ' On dispatch-scan-required, perform the scan and retry. Use the shared command block for report retries; after exhausted busy retries, use failure-response. Use one final heartbeat, including nothing-new checks; never append separate cards or assessment commentary. The runtime records reporting attempts, not delivery guarantees.',
          'After a failed runtime call, first follow the bounded exact-command host-access retry above when applicable. A native approval denial never authorizes repeating that action or using another route. For denied dispatch prepare or create_thread only, if native host authority permits further tracking, use the shared block with runtimeRoute:"dispatch" and runtimeInput:{action:"reconcile"} without a receipt. The block retains the exact operation id; never reconstruct it from history. If reconciliation returns nextAction next, continue unrelated eligible work and finish with the ordinary combined report. Otherwise stop the occurrence. The next permitted occurrence observes original native evidence before selecting work. Shared or ambiguous denials remain workflow stops. The operator must recover an exact item hold through retry-denied with its call id and fresh digest; time or reassignment does not clear it.',
          'If a failed runtime call remains unresolved, or the host does not permit further tracking after refusal, use intakeRuntime failure-response with automationId from this trigger and the stable returned code (codex-runtime-failed if none). It is a pure error formatter, not a quiet-success formatter, and does not need host state access. Copy its response verbatim once as the whole final answer. For native rejection submit only {automationId,code:"native-approval-denied"}, then include the actual bounded, redacted rejection reason once inside its heartbeat message, or say unavailable. Never echo a raw command, prompt, or credential. Do not put prose in code, add unsupported fields, reuse an earlier code, or duplicate a card outside the envelope. Stop with pending work intact; a failed operation did not succeed.',
        ].join('\n\n'),
      },
    },
  ];
}
