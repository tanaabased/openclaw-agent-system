import { automationHash } from './automation-hash.ts';
import { codexQuietHeartbeatInstructions } from './codex-heartbeat.ts';
import { projectRoutingProfile } from './model-routing.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

export const intakeAutomationId = 'github-issue-assignment';

export function codexIntakePolicy(manifest: AgentManifest) {
  const policy = manifest.github?.notifications;
  if (
    policy?.schemaVersion !== 2 ||
    !policy.runtimes.includes('codex') ||
    !policy.issueAssignment?.allowed.length
  )
    return;
  const username = manifest.github?.username;
  if (typeof username !== 'string') throw new IntakeError('intake-literal-identity-required');
  return {
    policy,
    username,
    digest: automationHash({ username, host: manifest.github?.host, policy }),
  };
}

/** desired policy adds one reserved job; the native planner still owns every mutation. */
export function codexIntakeJobs(manifest: AgentManifest): ResolvedAutomation[] {
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
          'Check GitHub for newly assigned issues from approved assigners and dispatch admitted plan-mode issues for read-only assessment in existing saved Codex projects. This schedule authorizes one native issue chat and worktree per retained issue; it never authorizes implementation or GitHub publication.',
          'Run the deterministic scan before any routine commentary or progress update. Use intakeRuntime.argvPrefix from the newest trusted Agent System context, followed by scan --plugin-data and intakeRuntime.pluginData. If that context is unavailable, report the blocker; never guess a workspace or executable.',
          'Even when the scan is unchanged, use native list_projects and call dispatchRuntime with {"action":"next","projects": <returned projects array>}. For every dispatch action, execute exactly dispatchRuntime.argvPrefix followed by --plugin-data and pluginData from the newest trusted Agent System context. Put action and all request data in JSON on stdin, using native stdin support or a quoted heredoc; never use a printf pipeline or put JSON in command arguments. If native approval is required, request only the full fixed command prefix including --plugin-data and its exact path; never a broad node or printf permission. The runtime owns eligibility, capacity, pending creation, recovery, and results; never choose assignments from prose.',
          'For routing-required, assess the returned bounded evidence against the returned routing rubric, preserving verified metadata and labeling content assessment. Derive a short two-to-six-word title description. Call dispatchRuntime with action:"prepare", id, digest, title, assessment, and fallback:"default" only when explicitly using the configured default. Do not supply model overrides. The helper validates and records the exact model and effort before creation.',
          "For a fresh prepared response, the next action is native create_thread with its exact request. When a code orchestration tool is available, execute prepare there, parse its successful JSON output into a variable, and pass that variable's request object directly to the native create_thread tool in the same execution. Do not print and then retype, summarize, or reconstruct the prompt. The child retrieves issue evidence through context, so do not add an issue snapshot. Only status prepared authorizes this one call; reconcile-required, creating, and uncertain outcomes never do.",
          "After create_thread, reconcile the same prepared id with receipt containing only threadId, clientThreadId, and hostId from that call's actual result. Never copy a receipt from history, another assignment, or a retired attempt, even when the issue number is the same. A freshly prepared id has no existing creation to reuse. A pending clientThreadId is not a ready threadId. If creation fails or its outcome is unknown, reconcile without receipt; never invent a receipt or repeat create_thread. For a runtime-issued repair, use native set_thread_title with that exact request once and reconcile again.",
          'Process the queue for at most twelve dispatch runtime actions per occurrence (next, prepare, and reconcile each count). After a completion notice, a successful launch/reconcile, or retained pending creation, call next again while budget remains. Do not end the occurrence merely because one issue was launched or completed. On busy, pause for two seconds and retry next, counting the retry toward the same budget; a child may briefly hold the journal while verifying context or saving its result. Stop on idle, at-capacity, required approval, or a failed tool call; stop at the budget even if work remains. Do not wait for child assessments to finish. Collect notices and report them together after the loop. Do not resend assessment prompts, change models, create replacement chats, clone repositories, register projects, or edit scheduler files. The child assessment skill records its structured result; Markdown headings never establish completion.',
          'Report only newly dispatched work, completed assessment, recovery, or a new actionable blocker, including required approval. When a changed runtime result includes message, reproduce that entire message verbatim in the final response, preserving its Markdown, actor/item links, action, and diagnostic. Do not paraphrase or replace the card with a summary. Use verified native chat links for other notices. When both intake and dispatch are unchanged or non-actionable, emit no user-facing prose outside the native heartbeat envelope and preserve DONT_NOTIFY. Disabled or revoked policy requires authorized Install to pause the owned job.',
          codexQuietHeartbeatInstructions,
          `Policy revision: ${selected.digest}.`,
        ].join('\n\n'),
      },
    },
  ];
}
