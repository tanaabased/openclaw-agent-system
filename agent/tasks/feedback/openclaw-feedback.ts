import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { type Static } from 'typebox';
import type GitHubReviewReplyClient from '../../../channels/github/provider/review-reply-client.ts';
import type { GitHubNotificationProviderClient } from '../../../channels/github/provider/work-event-types.ts';
import type { GitHubCanonicalWorkItem } from '../../../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import type { DispatchRequest } from '../../../credentials/session-dispatch.ts';
import type { dispatchParameters } from '../../../tools/dispatch/tool-schema.ts';
import { feedbackConversationMode } from './feedback-conversation-mode.ts';
import { feedbackInputContext } from './feedback-input.ts';
import feedbackPresentation from './feedback-presentation.ts';
import authorizeFeedback from './feedback-source-context.ts';
import { retainedIssueProgression } from '../issue-progression.ts';
import type { ManagedIssue as IntakeRecord } from '../managed-issue.ts';
import type { OpenClawDispatchRecord } from '../dispatch/openclaw-dispatch-state.ts';
import openClawFeedbackInput from './openclaw-feedback-input.ts';
import type { OpenClawFeedbackEvent } from './openclaw-feedback-state.ts';
import deliverOpenClawTaskInput from '../context/openclaw-task-input.ts';
import observeIssueActivity from '../../openclaw-session-activity.ts';
import type { DispatchCaller } from '../../openclaw-session-create.ts';
export { default as authorizeFeedback } from './feedback-source-context.ts';

export type OpenClawFeedbackProvider = GitHubNotificationProviderClient & {
  replies: Pick<GitHubReviewReplyClient, 'find' | 'create'>;
};
export type OpenClawFeedbackAction = Extract<
  Static<typeof dispatchParameters>,
  { action: 'feedback' }
>;

type ReauthorizeFeedback = () => Promise<GitHubCanonicalWorkItem | void>;

/** one recorded send, followed only by exact receipt reconciliation. */
export async function advanceFeedbackTurn(input: {
  record: OpenClawDispatchRecord;
  event: OpenClawFeedbackEvent;
  request: DispatchRequest;
  config: OpenClawConfig;
  save(): Promise<void>;
  assertCurrent(): Promise<void>;
  authorizeInput?(): Promise<void>;
  sourcePresentation?: string;
}) {
  const { record, event, request, save } = input;
  if (event.phase === 'delivered')
    return { status: 'feedback-completed' as const, id: record.id, eventId: event.id };
  const expected = record.request;
  if (!expected || !('key' in expected) || !record.sessionCreation?.verified)
    throw new Error('feedback-session-unverified');
  const receipt = await deliverOpenClawTaskInput({
    record,
    turn: event.turn,
    source: 'feedback',
    request,
    config: input.config,
    save: async () => {
      if (event.turn?.status === 'accepted') event.phase = 'running';
      await save();
    },
    assertCurrent: async () => {
      await input.assertCurrent();
      await input.authorizeInput?.();
    },
    retain(turn) {
      event.turn = turn;
      event.phase = 'prepared';
    },
    async prepare() {
      const session = await observeIssueActivity(request, record, input.config);
      // The host's followup queue preserves active work; feedback needs no idle gate.
      record.nativeInactive = !session.busy;
      if (typeof session.leaf !== 'string' || !session.leaf)
        throw new Error('feedback-session-unverified');
      const runId = `${record.id}:feedback:${event.id}`;
      const message = input.sourcePresentation;
      if (!message) throw new Error('feedback-source-presentation-required');
      return { runId, message, leaf: session.leaf };
    },
  });
  const settled = receipt.status === 'delivered';
  if (settled) {
    event.phase = 'delivered';
    delete event.code;
    record.feedback!.lastServedAt = Date.now();
  }
  delete event.retry;
  delete event.retryAfter;
  await save();
  return {
    status: settled ? 'feedback-completed' : 'feedback-pending',
    id: record.id,
    eventId: event.id,
  };
}

/** resolve the verified native input; outgoing replies have their own owner. */
export default async function openClawFeedback(input: {
  record: OpenClawDispatchRecord;
  event: OpenClawFeedbackEvent;
  action: OpenClawFeedbackAction;
  caller: DispatchCaller;
  request: DispatchRequest;
  config: OpenClawConfig;
  provider: OpenClawFeedbackProvider;
  policy: GitHubNotificationPolicy;
  intake: IntakeRecord;
  assertCurrent(): Promise<void>;
  reauthorize?: ReauthorizeFeedback;
  livePolicy?(): Promise<GitHubNotificationPolicy>;
  save(): Promise<void>;
}) {
  const { record, event, action, caller, request, provider, policy, intake, save } = input;
  if (Object.hasOwn(action, 'digest')) throw new Error('feedback-binding-override');
  const source = await authorizeFeedback({ ...input, conversation: true });
  const expected = record.request;
  if (!expected || !('key' in expected) || !event.turn) throw new Error('feedback-send-unverified');
  const owner = intake.repository.owner.login,
    name = intake.repository.name;
  const sourcePresentation = feedbackPresentation(event, owner + '/' + name);
  const self = source.author?.nodeId === provider.identity.nodeId;
  if (action.operation !== 'reconcile') {
    if (
      caller.sessionKey !== record.threadId ||
      caller.sessionId !== record.sessionCreation?.sessionId ||
      event.turn.cancelled
    )
      throw new Error('feedback-owner-caller-required');
    const selected = await openClawFeedbackInput(record, caller, request, input.config, event.id);
    if (!selected) throw new Error('feedback-input-unverified');
    const inputId = selected.inputId;
    if (!action.material) {
      event.turn.consumedByEventId = inputId;
      if (event.turn.status !== 'completed') event.turn.status = 'consumed';
      record.feedback!.context = {
        runId: caller.runId,
        eventId: event.id,
        inputEventId: inputId,
      };
      await save();
    }
  }
  {
    return {
      ...feedbackInputContext({
        runtime: 'openclaw',
        event,
        repository: owner + '/' + name,
        mode: feedbackConversationMode(record, (await input.livePolicy?.()) ?? policy),
        issueStage: retainedIssueProgression(record)?.stage ?? 'planning',
        self,
      }),
      runtime: 'openclaw',
      id: record.id,
      eventId: event.id,
      presentation: sourcePresentation,
      project: { path: record.worktree },
    };
  }
}
