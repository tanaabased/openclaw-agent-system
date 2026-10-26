import debugCard from '../channels/github/presentation/debug.ts';
import retirementNotice from './retirement-notice.ts';
import workflowRecovery from './workflow-recovery.ts';
import intakeAutomationNotice from '../channels/github/presentation/intake-automation-notice.ts';
import {
  providerDiagnostic as sanitizeProviderDiagnostic,
  type ProviderDiagnostic,
} from '../utils/provider-diagnostic.ts';
import githubNotificationCard, {
  githubNotificationMarkdownCode as inlineCode,
  githubNotificationMarkdownText as text,
} from '../channels/github/presentation/card.ts';

export type IssueNoticeEvent = 'intake-recovered' | 'failure';

interface NoticeCopy {
  severity: 'info' | 'warning' | 'error';
  emoji?: string;
  title: string;
  summary: string;
  next: string;
}

const events: Record<Exclude<IssueNoticeEvent, 'failure'>, NoticeCopy> = {
  'intake-recovered': {
    severity: 'info',
    title: 'Issue checks resumed',
    summary: 'The earlier problem checking assignments has cleared.',
    next: 'No action is needed. New assignments will be checked on the normal schedule.',
  },
};

function failure(code: string, diagnostic?: ProviderDiagnostic): NoticeCopy {
  const retirement = code.startsWith('retirement-') ? retirementNotice(code) : undefined;
  if (retirement) return retirement;
  if (code === 'intake-manifest-unavailable')
    return {
      severity: 'error',
      title: 'Cannot read the automation policy',
      summary: 'The bound workspace manifest is missing, unreadable, or invalid.',
      next: 'Restore a readable, valid `agent.yaml`, then retry. Policy-only repairs do not require Install or a new workspace binding.',
    };
  if (code === 'workflow-policy-held')
    return {
      severity: 'info',
      title: 'Waiting on current workflow policy',
      summary:
        'The live `agent.yaml` does not currently permit this automatic operation. Saved work and receipts are retained.',
      next: 'Update the relevant workflow setting to resume eligible work. Policy edits take effect without Install.',
    };
  const automation = intakeAutomationNotice(code);
  if (automation) return automation;
  const recovery = workflowRecovery(code, diagnostic);
  if (recovery)
    return {
      severity:
        diagnostic &&
        ['authentication', 'permission', 'missing-credential'].includes(diagnostic.classification)
          ? 'error'
          : 'warning',
      title:
        diagnostic?.provider === 'git'
          ? 'Git could not complete the operation'
          : diagnostic?.provider === 'github'
            ? 'GitHub could not complete the operation'
            : 'This operation needs attention',
      ...recovery,
    };
  if (code === 'dispatch-issue-inactive' || code === 'dispatch-assessment-retired')
    return {
      severity: 'warning',
      title: code === 'dispatch-assessment-retired' ? 'Issue retired' : 'Issue inactive',
      summary:
        'This issue is no longer active, so automated work is paused. Existing work is retained subject to its cleanup state.',
      next: 'Check whether the issue was closed, unassigned, or retired. Restore its active assignment when appropriate, then verify the retained chat and checkout before resuming; cleanup may already have completed.',
    };
  if (code === 'dispatch-assessment-handed-off')
    return {
      severity: 'info',
      title: 'Assessment handed off',
      summary:
        'This issue has moved beyond assessment. Its existing work and permissions are retained.',
      next: 'Use the owning implementation or delivery context in this chat to continue the requested work.',
    };
  if (code === 'dispatch-reset-pending')
    return {
      severity: 'warning',
      title: 'Issue reset pending',
      summary: 'A retained reset must be reconciled before this operation can continue.',
      next: 'Reconcile the existing reset and native receipt; preserve the chat and worktree.',
    };
  if (code === 'dispatch-native-occurrence-unavailable')
    return {
      severity: 'warning',
      title: 'Waiting for a scheduled intake run',
      summary: 'This operation could not verify a current native scheduled intake run.',
      next: 'After an ordinary operator message, wait for the next scheduled intake. Do not repeat the authorization or reuse an earlier trigger. If this happens during a scheduled run, inspect its native trigger and retained state; do not reset assignments or create replacement chats.',
    };
  if (code === 'delivery-body-required')
    return {
      severity: 'warning',
      title: 'The PR description is missing',
      summary: 'Automatic publication requires an explicit public description.',
      next: 'Compose a concise body with the implemented change, verified checks, limitations, and issue-required evidence. Prepare again with that body, then publish with the same body and returned digest. Do not copy private context.',
    };
  if (code === 'native-approval-denied')
    return {
      severity: 'error',
      title: 'Native approval rejected the operation',
      summary: 'The requested operation was rejected by native approval review.',
      next: 'Stop this operation and report the actual rejection reason. Preserve pending work and receipts; do not retry through another execution path.',
    };
  if (code === 'continuation-send-mismatch')
    return {
      severity: 'error',
      title: 'The continuation request changed in transit',
      summary:
        'The native send does not match the prepared request. Implementation is not authorized by this send.',
      next: 'Inspect the retained send and issue chat. An operator may preview a bounded continuation retry; do not resend the old request or relax receipt verification.',
    };
  if (code === 'private-state-file-lock-busy')
    return {
      severity: 'warning',
      title: 'Tracking files are temporarily busy',
      summary:
        'Another operation is updating the tracking files. This attempt could not finish within its bounded wait.',
      next: 'The next scheduled check will retry. Keep existing work and receipts. Do not delete the lock or reset the chat; if this persists, inspect the operation holding the journal.',
    };
  if (code === 'dispatch-recovery-stale')
    return {
      severity: 'warning',
      title: 'Refresh the recovery preview',
      summary:
        'The work or authority changed after the recovery preview. The requested transition was not applied.',
      next: 'Preview the same recovery action again without a digest, inspect the current result, and apply its new digest only if the existing authorization still covers it. For handoff, use `action:handoff` with the same id; do not refresh assessment context after implementation. If it becomes stale again, stop and inspect concurrent changes. Preserve the existing chat, branch, and commit.',
    };
  if (code === 'delivery-attachment-pending')
    return {
      severity: 'warning',
      title: 'PR attachment needs a check',
      summary:
        'The pull request is published, but its native chat attachment could not be verified.',
      next: 'Retry native attachment and its inventory check in this chat. The PR card remains available; do not create another PR.',
    };
  if (code === 'delivery-linkage-retried')
    return {
      severity: 'info',
      title: 'Issue link verified after retry',
      summary: 'GitHub confirmed the closing issue link on a later readback.',
      next: 'No action is needed. The existing pull request was retained.',
    };
  if (code === 'dispatch-project-git-auth-unavailable')
    return {
      severity: 'error',
      title: 'Git authentication failed',
      summary: 'Native Git could not authenticate to the repository.',
      next: 'Check the host Git credential or SSH setup, then retry the retained delivery. No Agent System credential changes are needed.',
    };
  if (code === 'github-delivery-linkage-unverified')
    return {
      severity: 'error',
      title: 'Issue link is not verified',
      summary:
        'The pull request exists, but GitHub has not confirmed its closing issue link after bounded readback attempts.',
      next: 'Inspect the existing PR and issue link, then resume the same delivery. Do not create another PR.',
    };
  if (code.startsWith('delivery-'))
    return {
      severity: 'error',
      title: 'Pull request delivery needs attention',
      summary: 'Delivery could not finish its required verification or publication step.',
      next: 'Inspect the diagnostic and retained PR, if present, then resume the same operation after resolving the problem.',
    };
  if (code === 'dispatch-scan-required')
    return {
      severity: 'warning',
      title: 'Check GitHub before reporting',
      summary:
        'This scheduled run has no fresh scan result, so it cannot yet report that nothing changed.',
      next: 'Run the deterministic intake scan, then request the report again. Do not reuse a previous run’s result.',
    };
  if (code === 'dispatch-check-required')
    return {
      severity: 'warning',
      title: 'The issue check has not finished',
      summary: 'This run has not verified whether more assigned work needs attention.',
      next: 'Complete the current scan and dispatch checks before reporting no updates. Keep existing chats and saved work; do not reset assignments.',
    };
  if (code === 'dispatch-native-history-incomplete' || code === 'dispatch-native-history-changed')
    return {
      severity: 'warning',
      title: 'Codex could not verify the chat history',
      summary: 'Codex could not provide a complete, consistent view of the relevant history.',
      next: 'Inspect the existing chat and retained creation receipt before continuing. Do not repeat an uncertain chat creation.',
    };

  if (code === 'codex-host-access-required')
    return {
      severity: 'warning',
      title: 'Codex needs access to its tracking files',
      summary:
        'The filesystem denied access to private plugin state outside this chat’s writable sandbox. The tracking lock prevents concurrent updates; this is not a password failure.',
      next: 'Retry this exact runtime command once through native host approval, retaining its JSON input and fixed plugin-data path. If approval is denied, stop and report the reason. If host access still fails, inspect directory ownership and host restrictions. Do not delete the lock, change permissions, reset the issue, or create a replacement chat.',
    };

  if (code === 'dispatch-assignment-authority-revoked')
    return {
      severity: 'warning',
      title: 'This assignment needs a check',
      summary: 'The issue no longer meets the requirements for automatic assessment.',
      next: 'Check whether the issue is still open, assigned to this agent, and authorized by the configured assigner. Keep any existing work.',
    };

  if (
    /state-|readback-diverged|identity-mismatch|identity-invalid|account-changed|resource-changed/u.test(
      code,
    )
  )
    return {
      severity: 'error',
      title: 'Could not verify the existing work',
      summary:
        'The saved record, account, repository, or chat did not match the expected identity.',
      next: 'Inspect the diagnostic and verify the account and retained work before retrying. Preserve the existing records and checkout.',
    };
  if (code === 'intake-permission-required')
    return {
      severity: 'warning',
      title: 'Permission is needed',
      summary: 'The requested operation needs native approval before it can continue.',
      next: 'Review the exact operation in the native approval prompt. Approval does not by itself prove the operation succeeded.',
    };
  if (
    /provider-unavailable|github-(transient|rate|secondary|server|transport|unknown)|search-incomplete|history-incomplete/u.test(
      code,
    )
  )
    return {
      severity: 'warning',
      title: 'Issue checks are temporarily paused',
      summary:
        'GitHub did not provide a complete usable response. The last successful checkpoint is retained.',
      next: 'The schedule will retry. If this persists, check GitHub connectivity, limits, and the configured repository scope.',
    };

  if (code === 'dispatch-project-registration-unavailable')
    return {
      severity: 'warning',
      title: 'Add the project to continue',
      summary: 'The repository is ready, but Codex needs it registered as a local project.',
      next: 'Add the specified folder as the primary folder of a local Codex project. The next scheduled check will verify it and resume this assignment.',
    };
  if (
    [
      'intake-activation-required',
      'dispatch-activation-required',
      'intake-automation-update-required',
    ].includes(code)
  )
    return {
      severity: 'warning',
      title: 'Refresh the intake configuration',
      summary: 'The saved automation and current settings do not agree. Existing work is retained.',
      next: 'Run Agent System Install to reconcile the automation, then retry any unsaved assessment in its existing chat.',
    };
  if (/policy-disabled/u.test(code))
    return {
      severity: 'info',
      title: 'Issue intake is disabled',
      summary: 'No new automated issue work will start. Existing chats and progress are retained.',
      next: 'The live policy holds new intake. Use Install to pause the saved schedule if desired; re-enabling requires Install only if that schedule was paused or removed.',
    };
  if (
    /authority|access|binding|authentication|identity|auth-unavailable|permission|forbidden/u.test(
      code,
    )
  )
    return {
      severity: 'warning',
      title: 'Check access before continuing',
      summary:
        'The workflow could not verify its configured identity, assignment, or repository access.',
      next: 'Check the bound profile and GitHub access, then retry the retained assignment. Do not create a replacement chat.',
    };
  if (
    /assessment-skill|assessment-guidance|configured-project|project-missing|plan-mode|profile-missing/u.test(
      code,
    )
  )
    return {
      severity: 'warning',
      title: 'Update the setup to continue',
      summary: 'A required project, assessment instruction, or model setting is unavailable.',
      next: 'Correct the indicated project, instruction, or model setting, then retry the retained operation. Live policy changes do not require Install.',
    };
  if (code === 'model-routing-metadata-conflict')
    return {
      severity: 'warning',
      title: 'Routing assessment conflicts with issue metadata',
      summary: 'The submitted complexity disagrees with the verified issue Complexity.',
      next: 'Refresh the retained assignment routing context and use its verified Complexity with the configured profile. No credential change, reset, or reassignment is needed.',
    };
  if (/model|routing/u.test(code))
    return {
      severity: 'error',
      title: 'Could not prepare the assessment model',
      summary: 'The requested model settings could not be resolved or verified.',
      next: 'Inspect the diagnostic and check model access and correct the request or model configuration, then retry the retained assignment.',
    };
  if (/repository|clone/u.test(code))
    return {
      severity: 'error',
      title: 'Could not prepare the repository',
      summary: 'Repository preparation stopped. Existing files have not been cleared for a retry.',
      next: 'Check the reported repository location and access. Preserve existing files while resolving the specific conflict.',
    };
  return {
    severity: 'error',
    title: 'The issue workflow could not continue',
    summary: 'An operation failed or the existing chat could not be verified.',
    next: 'Inspect the diagnostic and retained chat before retrying. Do not delete work or repeat an uncertain chat creation.',
  };
}

/** classify user impact independently of polling status and never render raw errors. */
export default function codexIssueNotice(input: {
  event: IssueNoticeEvent;
  changed: boolean;
  emoji?: string;
  code?: string;
  providerDiagnostic?: ProviderDiagnostic;
  issue?: { label: string; url: string };
  actionMarkdown?: string;
  facts?: { label: string; value: string }[];
}) {
  const diagnostic = input.providerDiagnostic
    ? sanitizeProviderDiagnostic(
        input.providerDiagnostic.provider,
        input.providerDiagnostic.operation,
        input.providerDiagnostic.classification,
        input.providerDiagnostic,
      )
    : undefined;
  const code = input.code && /^[a-z][a-z0-9-]{0,127}$/u.test(input.code) ? input.code : undefined;
  const copy =
    input.event === 'failure' ? failure(code ?? 'unknown', diagnostic) : events[input.event];
  const facts = [
    ...(input.issue
      ? [{ label: 'Issue', value: `[${text(input.issue.label)}](${input.issue.url})` }]
      : []),
    { label: 'What happened', value: copy.summary },
    { label: 'Next step', value: input.actionMarkdown ?? copy.next },
    ...(input.facts ?? []),
    ...(diagnostic?.httpStatus
      ? [{ label: 'HTTP status', value: String(diagnostic.httpStatus) }]
      : []),
    ...(diagnostic?.providerMessage
      ? [{ label: 'Provider detail', value: text(diagnostic.providerMessage) }]
      : []),
    ...(code ? [{ label: 'Technical detail', value: inlineCode(code) }] : []),
  ];
  return {
    title: copy.title,
    summary: copy.summary,
    next: copy.next,
    severity: copy.severity,
    notify: input.changed,
    message:
      code === 'delivery-linkage-retried'
        ? debugCard({ debug: true, context: 'Delivery recovery — ' + copy.title, facts })!
        : githubNotificationCard({
            emoji:
              copy.emoji ??
              (copy.severity === 'info'
                ? (input.emoji ?? '💡')
                : { warning: '⚠️', error: '❌' }[copy.severity]),
            title: copy.title,
            facts,
          }),
  };
}
