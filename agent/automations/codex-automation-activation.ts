import { workflowFeedbackAvailable } from '../../channels/github/feedback-policy.ts';
import { issuePickupAutomationId } from './issue-pickup-jobs.ts';
import { intakeAutomationId } from './codex-intake-policy.ts';
import { notificationAuthorityDigest } from '../notification-authority.ts';
import { automationHash } from '../automation-hash.ts';
import codexAutomationSchedule from './codex-automation-schedule.ts';
import { codexAutomationMarker, savedMatches } from './codex-automation-plan.ts';
import { readCodexAutomationSelection } from './codex-automation-state.ts';
import { CodexAutomationError } from './automation-errors.ts';
import {
  readCodexAutomationSnapshot,
  type CodexAutomationDependencies,
  type CodexAutomationSnapshot,
} from './codex-automation-snapshot.ts';

/** pickup consumes only its saved native job; a generic automation never supplies enrollment. */
export async function inspectCodexPickupActivation(
  pluginData: string,
  dependencies: CodexAutomationDependencies = {},
  acceptedOccurrence = false,
) {
  const selected = await readCodexAutomationSnapshot(pluginData, dependencies);
  return inspectSelectedCodexPickupActivation(selected, acceptedOccurrence);
}

/** reuse an inspection snapshot; effect entrypoints still obtain fresh evidence. */
export async function inspectSelectedCodexPickupActivation(
  selected: CodexAutomationSnapshot,
  acceptedOccurrence = false,
) {
  const job = selected.jobs.find((entry) => entry.id === issuePickupAutomationId);
  const record = selected.ledger.records.find((entry) => entry.id === issuePickupAutomationId);
  if (
    !job ||
    !record ||
    record.removed ||
    selected.ledger.pending?.action.manifestId === issuePickupAutomationId ||
    record.definition.kind !== 'heartbeat' ||
    job.payload.kind !== 'prompt'
  )
    throw new CodexAutomationError('issue-pickup-activation-required');
  const matches = await readCodexAutomationSelection(selected.codexHome, {
    nativeId: record.nativeId,
    marker: codexAutomationMarker(selected.scope, issuePickupAutomationId),
  });
  if (
    matches.length !== 1 ||
    matches[0]!.id !== record.nativeId ||
    !savedMatches(
      matches[0]!,
      acceptedOccurrence
        ? { ...record.definition, status: matches[0]!.definition.status }
        : record.definition,
      selected.workspace,
    ) ||
    record.definition.prompt !==
      job.payload.prompt +
        '\n\n' +
        codexAutomationMarker(selected.scope, issuePickupAutomationId) ||
    record.definition.rrule !== codexAutomationSchedule(job.schedule, record.definition.rrule)
  )
    throw new CodexAutomationError('issue-pickup-automation-drift');
  if (!acceptedOccurrence && (!job.enabled || record.definition.status !== 'ACTIVE'))
    throw new CodexAutomationError('issue-pickup-paused');
  return { threadId: record.definition.targetThreadId, nativeId: record.nativeId };
}

/** new dispatch requires active consent; retained work may verify its owner after a pause. */
export async function inspectCodexDispatchActivation(
  pluginData: string,
  dependencies: CodexAutomationDependencies = {},
  pausedRecovery = false,
  retainedWork = false,
  capability:
    | 'intake'
    | 'assessment'
    | 'implementation'
    | 'review'
    | 'publication'
    | 'feedback' = 'assessment',
) {
  const selected = await readCodexAutomationSnapshot(pluginData, dependencies);
  const job = selected.jobs.find((entry) => entry.id === intakeAutomationId);
  const record = selected.ledger.records.find((entry) => entry.id === intakeAutomationId);
  const activationCode =
    capability === 'intake'
      ? record
        ? 'intake-automation-update-required'
        : 'intake-activation-required'
      : 'dispatch-activation-required';
  if (!retainedWork && !pausedRecovery && job?.enabled === false)
    throw new CodexAutomationError('intake-automation-paused');
  const saved = record
    ? await readCodexAutomationSelection(selected.codexHome, {
        nativeId: record.nativeId,
        marker: codexAutomationMarker(selected.scope, intakeAutomationId),
      })
    : [];
  const actual = saved.find((entry) => entry.id === record?.nativeId);
  if (!retainedWork && !pausedRecovery && actual?.definition.status === 'PAUSED')
    throw new CodexAutomationError('intake-automation-paused');
  const matchesPrompt = (prompt: string) => {
    const marker = '\n\n' + codexAutomationMarker(selected.scope, intakeAutomationId);
    return job?.payload.kind === 'prompt' && prompt === job.payload.prompt + marker;
  };
  if (
    (selected.cleanupOnly && (!retainedWork || !selected.policyBlocker)) ||
    (!retainedWork && selected.ledger.pending?.action.manifestId === intakeAutomationId) ||
    !record ||
    record.definition.kind !== 'heartbeat' ||
    (!retainedWork &&
      (!job ||
        job.payload.kind !== 'prompt' ||
        record.removed ||
        record.definition.status !== 'ACTIVE' ||
        !matchesPrompt(record.definition.prompt)))
  )
    throw new CodexAutomationError(activationCode);
  if (
    !retainedWork &&
    (saved.length !== 1 ||
      !actual ||
      !savedMatches(
        actual,
        pausedRecovery ? { ...record.definition, status: 'PAUSED' } : record.definition,
        selected.workspace,
      ))
  )
    throw new CodexAutomationError(activationCode);
  if (capability === 'intake' || capability === 'assessment')
    return { sourceThreadId: record.definition.targetThreadId };
  // New workflows require current activation; retained tasks keep their recorded scope.
  if (
    capability === 'review' ||
    (!retainedWork &&
      (pausedRecovery ||
        !selected.loaded.manifest.github?.notifications ||
        (capability === 'feedback'
          ? !workflowFeedbackAvailable(
              selected.loaded.manifest.github.notifications,
              'issue-assignment',
            )
          : !['work', 'auto'].includes(
              selected.loaded.manifest.github.notifications.issueAssignment?.mode ?? '',
            )) ||
        !job ||
        job.payload.kind !== 'prompt' ||
        record.removed ||
        record.definition.status !== 'ACTIVE' ||
        !matchesPrompt(record.definition.prompt)))
  )
    throw new Error('workflow-schedule-reconciliation-required');
  const authority = {
    workflow: 'issue-assignment' as const,
    automationId: record.nativeId,
    sourceThreadId: record.definition.targetThreadId,
    policyDigest: notificationAuthorityDigest(selected.loaded.manifest.github?.notifications),
    definitionDigest: automationHash(record.definition),
  };
  return {
    sourceThreadId: authority.sourceThreadId,
    schedule: {
      current: authority,
      saved: {
        ...authority,
        version: 1 as const,
        capabilities: (capability === 'feedback'
          ? ['feedback', 'publication']
          : ['assessment', 'implementation', 'publication']) as Array<
          'assessment' | 'implementation' | 'publication' | 'feedback'
        >,
      },
    },
  };
}
