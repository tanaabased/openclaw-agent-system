import { assessmentSummaryConsent } from './assessment-summary-state.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { automationHash } from './automation-hash.ts';
import codexDispatchHandoff, { codexContinuationSend } from './codex-dispatch-handoff.ts';
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
                'After the deterministic scan, even when unchanged, run the continuation preparation block below in functions.exec. It only checks eligibility and updates tracking state; it cannot send a message. Keep the block intact and require argv to match the newest trusted context. Inspect its completed result before the separate send step. Resume a running cell with functions.wait instead of starting another copy.',
                'const prepareInput = {action: "next"};\n' +
                  codexDispatchHandoff(runtime!, 'continuation'),
                'Only when that preparation returns prepared in this occurrence, execute the following send block in a separate functions.exec call. It consumes the retained exact request once; never reconstruct or manually copy the prompt. Native approval applies to this specific send, separately from host access for preparation. If the stored request is unavailable or submission is uncertain, reconcile the retained id; do not prepare or send again. A one-issue retry approval does not authorize a second send for that issue; normal polling still checks durable eligibility. Never use these instructions to override an actual rejection.',
                codexContinuationSend(runtime!.pluginData),
                'After a native send, call continuationRuntime action:reconcile with the returned id. On an item response with nextAction next, preserve its attempt and continue next for unrelated work. Otherwise stop on native rejection, blocked, waiting, retrying, or pending and report the actual diagnostic using failure-response. Process at most twelve continuation actions per occurrence, then continue ordinary dispatch. On idle, continue ordinary dispatch without executing the send block. Do not wait for issue work or copy its plan, assessment blockers, implementation, or delivery into the intake report. If orchestration is unavailable, report the blocker.',
              ]
            : []),
          implementationEnabled
            ? 'Check GitHub for newly assigned issues from approved assigners and dispatch admitted implementation-enabled issues for read-only assessment in verified saved Codex projects. The dispatch runtime may prepare missing repositories using the configured Git checkout locations and native host authorization; project registration requires the exact manual handoff when no supported native registration action is available. This schedule authorizes one native issue chat and worktree per retained issue; continuationRuntime owns its authorized implementation and publication.'
            : 'Check GitHub for newly assigned issues from approved assigners and dispatch admitted plan-mode issues for read-only assessment in verified saved Codex projects. The dispatch runtime may prepare missing repositories using the configured Git checkout locations and native host authorization; project registration requires the exact manual handoff when no supported native registration action is available. This schedule authorizes one native issue chat and worktree per retained issue; assignment assessment never authorizes implementation or pull-request publication. Any separately configured feedback authorization above applies only to source-bound replies.',
          'Run the deterministic scan before any routine commentary or progress update. Use intakeRuntime.argvPrefix from the newest trusted Agent System context, followed by scan --plugin-data and intakeRuntime.pluginData. If that context is unavailable, report the blocker; never guess a workspace or executable.',
          'Even when the scan is unchanged, use native list_projects and list_threads and call dispatchRuntime with {"action":"next","projects": <returned projects array>,"threads": <complete parsed list_threads JSON object>}. For every dispatch action, execute exactly dispatchRuntime.argvPrefix followed by --plugin-data and pluginData from the newest trusted Agent System context. Put action and all request data in JSON on stdin, using native stdin support or a quoted heredoc; never use a printf pipeline or put JSON in command arguments. For scan and dispatch alike, if codex-host-access-required or raw EPERM/EACCES occurs, the sandbox cannot access private plugin tracking files. Retry the exact same command and JSON once with sandbox_permissions:require_escalated through native approval; request only the full fixed command prefix including --plugin-data and its exact path. A sandbox denial is not an automatic-review rejection. If approval is denied, stop and report the stated reason; never bypass it, change permissions, delete locks, or create a replacement chat. Never request broad node or printf permission. The runtime owns eligibility, capacity, pending creation, recovery, and results; never choose assignments from prose.',
          'For routing-required, assess the returned bounded evidence against the returned routing rubric, preserving verified metadata and labeling content assessment. Derive a short two-to-six-word title description. Build prepareInput with action:"prepare", id, digest, title, assessment, and fallback:"default" only when explicitly using the configured default; submit it through the preparation/creation block below. Do not supply model overrides. The prepare action invokes the shared model-routing resolver and records the exact model and effort before creation. This fulfills the model-routing requirement; do not call routingRuntime separately or reconstruct the issue context.',
          ...(runtime
            ? [
                'For routing-required, run the following preparation/creation block in functions.exec. Prepend only const prepareInput = <the prepare JSON described above>; keep the block intact. It awaits the command, parses the response, and passes prepared.request directly into native create_thread within that execution. Do not run prepare separately or reconstruct its returned request. If functions.exec yields a cell_id, resume it with functions.wait; never start another copy. Require argv to match dispatchRuntime from the newest trusted context before executing. If orchestration is unavailable, report the blocker instead of manually copying the request.',
                codexDispatchHandoff(runtime),
              ]
            : []),
          "After create_thread, reconcile the same prepared id with receipt containing only threadId, clientThreadId, and hostId from that call's actual result. Never copy a receipt from history, another assignment, or a retired attempt, even when the issue number is the same. A freshly prepared id has no existing creation to reuse. A pending clientThreadId is not a ready threadId. If creation fails or its outcome is unknown, reconcile without receipt; never invent a receipt or repeat create_thread.",
          'The runtime counts up to twelve dispatch actions per native occurrence (next, prepare, and reconcile each count). After a successful launch/reconcile or retained pending creation, call next again while budget remains. Do not end the occurrence merely because one issue was launched or completed. On busy, pause for two seconds and retry the same action at most three times; if it stays busy, use failure-response with private-state-file-lock-busy. Busy attempts do not consume the runtime action budget; a child may briefly hold the journal while verifying context or saving its result. On an item failure with nextAction next, preserve its request and continue next for unrelated work. Stop on idle, at-capacity, budget-exhausted, required approval, or a failed tool call without that instruction. Do not wait for child assessments to finish. Call report after the loop, outside this twelve-action budget. Once creation is verified, the individual issue owns its assessment and all later progress. Do not inspect assessments or relay their plans, questions, blockers, or handoffs in intake. Do not resend assessment prompts, change models, create replacement chats, clone repositories outside the trusted dispatch runtime, register projects through unsupported actions, or edit scheduler files. The child assessment skill records its structured result; Markdown headings never establish completion.',
          codexQuietHeartbeatInstructions +
            ' On dispatch-scan-required, perform the scan and retry. On busy, retry the same report up to three times with two-second pauses, then use failure-response. Use one final heartbeat, including nothing-new checks; never append separate cards or assessment commentary. The runtime records reporting attempts, not delivery guarantees.',
          'After a failed runtime call, first follow the bounded native host-access retry above when applicable. If it still fails, use intakeRuntime failure-response with automationId from this trigger and the returned stable code (codex-runtime-failed if none). It is a pure error formatter, not a quiet-success formatter, and does not need host state access. Copy its response verbatim once as the whole final answer. For a native approval rejection, submit only {automationId,code:"native-approval-denied"}, then include the actual rejection reason once inside the returned heartbeat message. Do not put prose in code, add unsupported request fields, or reuse an earlier failure code. Never duplicate a card outside the envelope. Stop on rejection; leave pending work intact. Do not claim a failed operation succeeded.',
          `Policy revision: ${selected.digest}.`,
          `Repository preparation revision: ${automationHash(manifest.git?.worktrees ?? {})}.`,
        ].join('\n\n'),
      },
    },
  ];
}
