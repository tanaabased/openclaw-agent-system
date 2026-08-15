import type {
  GitHubNotificationAcknowledgmentState,
  GitHubNotificationActivationState,
  GitHubNotificationCommentTurnState,
  GitHubNotificationDeliveryStage,
  GitHubNotificationItemDisposition,
  GitHubNotificationMonitorState,
} from './monitor-state.ts';

export type GitHubNotificationWaitTarget =
  | 'acknowledgment-published'
  | 'active'
  | 'assignment-rejected'
  | 'baseline-ready'
  | 'comment-received'
  | 'comment-rejected'
  | 'comment-replied'
  | 'planning-complete'
  | 'received'
  | 'retired';

export const githubNotificationWaitTargets = new Set<GitHubNotificationWaitTarget>([
  'acknowledgment-published',
  'active',
  'assignment-rejected',
  'baseline-ready',
  'comment-received',
  'comment-rejected',
  'comment-replied',
  'planning-complete',
  'received',
  'retired',
]);

export interface GitHubNotificationItemSelector {
  itemType: 'issue' | 'pull-request';
  number: number;
  repository: string;
}

export interface GitHubNotificationStatusComment {
  commentId: number;
  disposition: 'approved' | 'baseline' | 'rejected';
  reasonCode: string;
  reply?: GitHubNotificationAcknowledgmentState;
  turn?: GitHubNotificationCommentTurnState;
}

export interface GitHubNotificationStatusItem {
  acknowledgment?: GitHubNotificationAcknowledgmentState;
  commentDiagnosticCode?: string;
  comments: GitHubNotificationStatusComment[];
  disposition: GitHubNotificationItemDisposition;
  failureCode?: string;
  itemType: 'issue' | 'pull-request';
  mode?: 'auto' | 'plan' | 'work';
  number: number;
  planning?: GitHubNotificationActivationState;
  pullRequest?: {
    baseRef: string;
    draft: boolean;
    headRef: string;
    headSha: string;
  };
  reasonCode: string;
  repository: string;
  session: 'pending' | 'recorded';
  stage?: GitHubNotificationDeliveryStage;
  worktree: 'not-applicable' | 'pending' | 'ready';
}

export interface GitHubNotificationStatusResult {
  agentId: string;
  baseline: { observedAt?: number; status: 'pending' | 'ready' };
  code: string;
  diagnosticCode?: string;
  items: GitHubNotificationStatusItem[];
  schemaVersion: 1;
  status: 'degraded' | 'pending' | 'ready';
}

export interface GitHubNotificationWaitObservation {
  code: string;
  status: 'failed' | 'pending' | 'reached';
}

function matchesSelector(
  item: GitHubNotificationStatusItem,
  selector: GitHubNotificationItemSelector,
): boolean {
  return (
    item.itemType === selector.itemType &&
    item.number === selector.number &&
    item.repository.toLowerCase() === selector.repository.toLowerCase()
  );
}

/** Project private monitor state into a value-free operator and test surface. */
export function githubNotificationMonitorStatus(
  agentId: string,
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): GitHubNotificationStatusResult {
  if (!state) {
    return {
      agentId,
      baseline: { status: 'pending' },
      code: 'github-notification-status-pending',
      items: [],
      schemaVersion: 1,
      status: 'pending',
    };
  }

  const items = Object.values(state.items)
    .map((item): GitHubNotificationStatusItem => {
      const delivery = item.delivery;
      const repository = `${item.repositoryOwner}/${item.repositoryName}`;
      const comments = Object.values(item.commentTracking?.revisions ?? {})
        .sort(
          (left, right) =>
            left.commentDatabaseId - right.commentDatabaseId || left.updatedAt - right.updatedAt,
        )
        .map((comment) => ({
          commentId: comment.commentDatabaseId,
          disposition: comment.disposition,
          reasonCode: comment.reasonCode,
          ...(comment.reply === undefined ? {} : { reply: comment.reply }),
          ...(comment.turn === undefined ? {} : { turn: comment.turn }),
        }));
      return {
        ...(delivery?.acknowledgment === undefined
          ? {}
          : { acknowledgment: delivery.acknowledgment }),
        ...(item.commentTracking?.diagnosticCode === undefined
          ? {}
          : { commentDiagnosticCode: item.commentTracking.diagnosticCode }),
        comments,
        disposition: item.disposition,
        ...(delivery?.failureCode === undefined ? {} : { failureCode: delivery.failureCode }),
        itemType: item.itemType,
        ...(delivery?.mode === undefined ? {} : { mode: delivery.mode }),
        number: item.number,
        ...(delivery?.activation === undefined ? {} : { planning: delivery.activation }),
        ...(item.pullRequest === undefined
          ? {}
          : {
              pullRequest: {
                baseRef: item.pullRequest.baseRef,
                draft: item.pullRequest.draft,
                headRef: item.pullRequest.headRef,
                headSha: item.pullRequest.headSha,
              },
            }),
        reasonCode: item.reasonCode,
        repository,
        session: delivery?.sessionKey ? 'recorded' : 'pending',
        ...(delivery?.stage === undefined ? {} : { stage: delivery.stage }),
        worktree:
          item.itemType === 'pull-request'
            ? 'not-applicable'
            : delivery?.worktreeBranch && delivery.worktreePath
              ? 'ready'
              : 'pending',
      };
    })
    .filter((item) => selector === undefined || matchesSelector(item, selector))
    .sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) ||
        left.number - right.number ||
        left.itemType.localeCompare(right.itemType),
    );
  const pending = state.baselineAt === undefined || state.lastSuccessfulPollAt === undefined;
  return {
    agentId,
    baseline: {
      ...(state.baselineAt === undefined ? {} : { observedAt: state.baselineAt }),
      status: state.baselineAt === undefined ? 'pending' : 'ready',
    },
    code: state.diagnosticCode
      ? state.diagnosticCode
      : pending
        ? 'github-notification-status-pending'
        : 'github-notification-status-ready',
    ...(state.diagnosticCode === undefined ? {} : { diagnosticCode: state.diagnosticCode }),
    items,
    schemaVersion: 1,
    status: state.diagnosticCode ? 'degraded' : pending ? 'pending' : 'ready',
  };
}

function selectedItem(
  result: GitHubNotificationStatusResult,
  selector: GitHubNotificationItemSelector | undefined,
): GitHubNotificationStatusItem | undefined {
  if (!selector) return undefined;
  return result.items.find((item) => matchesSelector(item, selector));
}

function itemFailure(
  item: GitHubNotificationStatusItem,
  target: GitHubNotificationWaitTarget,
  commentId?: number,
): string | undefined {
  if (item.failureCode) return item.failureCode;
  if (target.startsWith('comment-') && item.commentDiagnosticCode) {
    return item.commentDiagnosticCode;
  }
  if (item.planning?.status === 'failed' && target === 'planning-complete') {
    return item.planning.failureCode ?? 'github-notification-activation-failed';
  }
  if (item.acknowledgment?.status === 'failed' && target === 'acknowledgment-published') {
    return item.acknowledgment.failureCode;
  }
  if (target.startsWith('comment-') && commentId !== undefined) {
    const comment = item.comments.find((candidate) => candidate.commentId === commentId);
    if (comment?.turn?.status === 'failed') {
      return comment.turn.failureCode ?? 'github-notification-comment-dispatch-failed';
    }
    if (comment?.reply?.status === 'failed') return comment.reply.failureCode;
  }
  return undefined;
}

/** Evaluate one semantic wait target without parsing chat presentation or provider prose. */
export function evaluateGitHubNotificationWait(
  result: GitHubNotificationStatusResult,
  target: GitHubNotificationWaitTarget,
  selector?: GitHubNotificationItemSelector,
  commentId?: number,
): GitHubNotificationWaitObservation {
  if (result.diagnosticCode) return { code: result.diagnosticCode, status: 'failed' };
  if (target === 'baseline-ready') {
    return result.baseline.status === 'ready'
      ? { code: 'github-notification-baseline-ready', status: 'reached' }
      : { code: 'github-notification-wait-pending', status: 'pending' };
  }
  const item = selectedItem(result, selector);
  if (!item) return { code: 'github-notification-wait-pending', status: 'pending' };
  const failureCode = itemFailure(item, target, commentId);
  if (failureCode) return { code: failureCode, status: 'failed' };

  let reached = false;
  if (target === 'assignment-rejected') reached = item.disposition === 'rejected';
  if (target === 'received') {
    reached = item.stage === 'received' || item.stage === 'active' || item.stage === 'retired';
  }
  if (target === 'active') reached = item.stage === 'active';
  if (target === 'planning-complete') reached = item.planning?.status === 'planned';
  if (target === 'acknowledgment-published') {
    reached = item.acknowledgment?.status === 'published';
  }
  if (target === 'retired') reached = item.stage === 'retired';
  if (target.startsWith('comment-') && commentId !== undefined) {
    const comment = item.comments.find((candidate) => candidate.commentId === commentId);
    if (target === 'comment-rejected') reached = comment?.disposition === 'rejected';
    if (target === 'comment-received') {
      reached = comment?.disposition === 'approved' && comment.turn !== undefined;
    }
    if (target === 'comment-replied') {
      reached = comment?.turn?.status === 'responded' && comment.reply?.status === 'published';
    }
  }
  return reached
    ? { code: `github-notification-${target}`, status: 'reached' }
    : { code: 'github-notification-wait-pending', status: 'pending' };
}
