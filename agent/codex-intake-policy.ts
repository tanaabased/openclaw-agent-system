import { assessmentSummaryConsent } from './assessment-summary-state.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { automationHash } from './automation-hash.ts';
import codexDispatchHandoff, { codexNativeHandoff } from './codex-dispatch-handoff.ts';
import { codexQuietHeartbeatInstructions } from './codex-heartbeat.ts';
import { projectRoutingProfile } from './model-routing.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

export const intakeAutomationId = 'github-issue-assignment';

/** retained work still checks authority; enablement controls new admissions. */
export function codexIntakePolicy(manifest: AgentManifest, retainedWork = false) {
  return assignmentIntakePolicy(manifest, 'codex', retainedWork);
}

/** desired policy adds one reserved job; the native planner still owns every mutation. */
export function codexIntakeJobs(
  manifest: AgentManifest,
  runtime?: { nodeExecutable: string; entrypoint: string; pluginData: string },
  legacyPolicy = false,
): ResolvedAutomation[] {
  const jobs = manifest.automations ?? [];
  if (jobs.some((job) => job.id === intakeAutomationId))
    throw new IntakeError('intake-automation-id-reserved');
  const selected = codexIntakePolicy(manifest);
  if (!selected) return jobs;
  if (!manifest.models?.low) throw new IntakeError('intake-low-profile-required');
  const model = projectRoutingProfile(manifest.models.low, 'codex');
  if (model.status !== 'mapped') throw new IntakeError(model.code);
  const implementationEnabled = ['work', 'auto'].includes(
    selected.policy.issueAssignment?.mode ?? '',
  );
  if (implementationEnabled && !runtime)
    throw new IntakeError('continuation-runtime-identity-required');
  return [
    ...jobs,
    {
      id: intakeAutomationId,
      displayName: '📥 ISSUE ASSIGNMENTS',
      enabled: true,
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
          ...(feedbackIdentities(
            selected.policy.issueAssignment?.allowed ?? [],
            selected.policy.issueAssignment?.feedback,
          ).length
            ? [
                'Feedback authorization: by activating this saved workflow, the operator authorizes routine source-bound public replies to configured feedback authors on managed issues and verified delivery PRs, without per-comment human confirmation. Native approval review remains in force; an explicit denial stops publication and requires fresh operator intervention. Feedback may resume the existing issue chat for private explanation and a concise public reply, regardless of issue mode. It never grants implementation, review, or a mode change. Publication is authorized only through the source-bound feedbackRuntime operation after fresh authorization checks and an exact destination-and-draft preview with a matching digest.',
                'dispatchRuntime next also scans and schedules feedback within the same item capacity. On feedback-prepared, pass the exact returned request once to native send_message_to_thread, then call feedbackRuntime action:reconcile with id and eventId. Never send again after uncertainty or denial. Continue next while budget remains; count feedback actions within the same twelve-action occurrence budget. Feedback answers and publication outcomes stay in the owning chat. Intake reports only verified sends, queued feedback and changed intake obstacles.',
              ]
            : []),
          ...(implementationEnabled
            ? [
                selected.policy.issueAssignment?.mode === 'auto'
                  ? 'Auto-mode authorization: the operator activates assessment and conditional implementation and pull-request delivery. Only a durably recorded proceed decision from an actionable assessment may continue through continuationRuntime. A wait or missing/invalid decision stops for operator direction in the original issue chat. This recommendation never grants authority; native approval review, cancellation, lost authority, and substantive blockers stop work. No routine stage approval is required after a valid proceed decision and fresh authority checks.'
                  : 'Work-mode authorization: the operator activates the complete assessment, implementation, and pull-request delivery workflow. No per-stage human approval is required. Continue actionable assessments in their original issue chats using continuationRuntime, preserving native approval review and stopping on actual denial, cancellation, lost authority, or substantive blockers.',
                'Installed continuation command (argv data, recorded by the runtime during native schedule activation): ' +
                  JSON.stringify([
                    runtime!.nodeExecutable,
                    runtime!.entrypoint,
                    'continuation',
                    '--plugin-data',
                    runtime!.pluginData,
                  ]) +
                  '. Require this command to match continuationRuntime from the newest trusted context. If it differs, stop for Install reconciliation; do not substitute paths. Send the request JSON on stdin, without --input.',
                "Continuation preparation has the same boundary as assessment preparation: action:next and action:reconcile read the activated schedule, GitHub assignment, selected skill, worktree, and native chat receipts, and update private tracking state. They do not edit repository files, start model work, push commits, or publish a pull request. Only a separate native send_message_to_thread starts implementation from the returned prepared request. Publication occurs later through the issue chat's separately verified delivery action. Native host-access approval for next or reconcile covers this preparation and tracking operation; it does not approve every action of the continuation runtime. On codex-host-access-required, retry the exact command and JSON once through native approval with this bounded purpose and installed identity, then stop on denial.",
                'After the deterministic scan, even when unchanged, use the shared scheduled command block below with runtimeRoute:"continuation" and runtimeInput:{action:"next"}. It only checks eligibility and updates tracking state; it cannot send a message.',
                'Only when continuation next returns prepared in this occurrence, execute the following send block in a separate functions.exec call. It consumes the retained exact request once. Native approval applies to that send separately from host-access preparation. If submission is uncertain, reconcile the retained id without sending again. An issue-specific retry grant applies only to that recovery; it neither grants another send nor restricts unrelated assignments authorized by the active recurring workflow. An explicit operator pause or restriction still applies. Never override an actual rejection.',
                codexNativeHandoff(runtime!.pluginData, 'continuation'),
                'After a native send, call continuationRuntime action:reconcile with the returned id. On an item response with nextAction next, preserve its attempt and continue next for unrelated work. Otherwise stop on native rejection, blocked, waiting, retrying, or pending and report the actual diagnostic using failure-response. Process at most twelve continuation actions per occurrence, then continue ordinary dispatch. On idle, continue ordinary dispatch without executing the send block. Do not wait for issue work or copy its plan, assessment blockers, implementation, or delivery into the intake report. If orchestration is unavailable, report the blocker.',
              ]
            : []),
          implementationEnabled
            ? 'Check GitHub for newly assigned issues from approved assigners and dispatch admitted implementation-enabled issues for read-only assessment in verified saved Codex projects. The dispatch runtime may prepare missing repositories using the configured Git checkout locations and native host authorization; project registration requires the exact manual handoff when no supported native registration action is available. This schedule authorizes one native issue chat and worktree per retained issue; continuationRuntime owns its authorized implementation and publication.'
            : 'Check GitHub for newly assigned issues from approved assigners and dispatch admitted plan-mode issues for read-only assessment in verified saved Codex projects. The dispatch runtime may prepare missing repositories using the configured Git checkout locations and native host authorization; project registration requires the exact manual handoff when no supported native registration action is available. This schedule authorizes one native issue chat and worktree per retained issue; assignment assessment never authorizes implementation or pull-request publication. Any separately configured feedback authorization above applies only to source-bound replies.',
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
          'After a failed runtime call, first follow the bounded native host-access retry above when applicable. If it still fails, use intakeRuntime failure-response with automationId from this trigger and the returned stable code (codex-runtime-failed if none). It is a pure error formatter, not a quiet-success formatter, and does not need host state access. Copy its response verbatim once as the whole final answer. For a native approval rejection, submit only {automationId,code:"native-approval-denied"}, then include the actual rejection reason once inside the returned heartbeat message. Do not put prose in code, add unsupported request fields, or reuse an earlier failure code. Never duplicate a card outside the envelope. Stop on rejection; leave pending work intact. Do not claim a failed operation succeeded.',
          `Policy revision: ${legacyPolicy ? selected.legacyDigest : selected.digest}.`,
          `Repository preparation revision: ${automationHash(manifest.git?.worktrees ?? {})}.`,
        ].join('\n\n'),
      },
    },
  ];
}
