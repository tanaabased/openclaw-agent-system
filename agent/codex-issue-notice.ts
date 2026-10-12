import githubNotificationCard, {
  githubNotificationMarkdownText as text,
} from '../channels/github/conversation/presentation/card.ts';

export type IssueNoticeEvent =
  | 'started'
  | 'plan-ready'
  | 'clarification-needed'
  | 'handoff'
  | 'recovered'
  | 'intake-recovered'
  | 'failure';

interface NoticeCopy {
  severity: 'info' | 'warning' | 'error';
  title: string;
  summary: string;
  next: string;
}

const events: Record<Exclude<IssueNoticeEvent, 'failure'>, NoticeCopy> = {
  started: {
    severity: 'info',
    title: 'Assessment started',
    summary: 'The issue has its own chat for investigation and a plan.',
    next: 'Follow progress in the issue chat. No action is needed yet.',
  },
  'plan-ready': {
    severity: 'info',
    title: 'Plan ready for review',
    summary: 'The assessment and plan have been saved in the issue chat.',
    next: 'Review the plan there, then request changes or authorize the next step.',
  },
  'clarification-needed': {
    severity: 'warning',
    title: 'A decision is needed',
    summary: 'The assessment has a question that needs your answer.',
    next: 'Answer in the existing issue chat so the assessment can continue.',
  },
  handoff: {
    severity: 'info',
    title: 'Work continuing in the issue chat',
    summary:
      'The assessment watcher has stopped checking this chat. Your conversation and local changes are retained.',
    next: 'Continue in the existing issue chat. No reset or reassignment is needed.',
  },
  'intake-recovered': {
    severity: 'info',
    title: 'Issue checks resumed',
    summary: 'The earlier problem checking assignments has cleared.',
    next: 'No action is needed. New assignments will be checked on the normal schedule.',
  },
  recovered: {
    severity: 'info',
    title: 'Assessment resumed',
    summary: 'The previously reported obstacle has cleared.',
    next: 'Follow progress in the existing chat. No action is needed now.',
  },
};

function failure(code: string): NoticeCopy {
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
  if (/activation|reconciliation|policy-changed/u.test(code))
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
      next: 'If the old schedule is still active, run Agent System Install to pause it. Re-enabling also requires Install.',
    };
  if (/worktree-diverged|assessment-worktree-changed/u.test(code))
    return {
      severity: 'warning',
      title: 'Confirm how this chat should continue',
      summary: 'The checkout changed while this issue was still tracked as a read-only assessment.',
      next: 'If you approved implementation, record the assessment handoff in the existing chat. Otherwise inspect the changes there before resuming assessment. Keep the current worktree.',
    };
  if (/assessment-result-missing/u.test(code))
    return {
      severity: 'error',
      title: 'The assessment did not record a result',
      summary:
        'The chat stopped without a saved assessment outcome. Its existing conversation is retained.',
      next: 'Open that chat and resume or retry saving its assessment. If you already approved further work, record a handoff instead.',
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
      next: 'Correct the indicated setting and reconcile configuration changes through Agent System Install.',
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
  code?: string;
  issue?: { label: string; url: string };
  threadId?: string;
  action?: string;
  facts?: { label: string; value: string }[];
}) {
  const code = input.code && /^[a-z][a-z0-9-]{0,127}$/u.test(input.code) ? input.code : undefined;
  const copy = input.event === 'failure' ? failure(code ?? 'unknown') : events[input.event];
  const facts = [
    ...(input.issue
      ? [{ label: 'Issue', value: `[${text(input.issue.label)}](${input.issue.url})` }]
      : []),
    ...(input.threadId
      ? [
          {
            label: 'Chat',
            value: `[Open issue chat](codex://threads/${encodeURIComponent(input.threadId)})`,
          },
        ]
      : []),
    { label: 'What happened', value: copy.summary },
    { label: 'Next step', value: input.action ? text(input.action) : copy.next },
    ...(input.facts ?? []),
    ...(code ? [{ label: 'Technical detail', value: '`' + code + '`' }] : []),
  ];
  return {
    severity: copy.severity,
    notify: input.changed && input.event !== 'handoff',
    message: githubNotificationCard({
      emoji: { info: 'ℹ️', warning: '⚠️', error: '❌' }[copy.severity],
      title: copy.title,
      facts,
    }),
  };
}
