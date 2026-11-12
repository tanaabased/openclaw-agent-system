import { withDispatchTask } from './dispatch-task-scope.ts';
import { omit } from 'lodash-es';
import resolveGitProtocol from '../tools/git/protocol.ts';
import {
  codexSkillResolver,
  type default as codexAssessmentSkill,
} from './tasks/assessment/codex-assessment-skill.ts';
import codexContinuationNative from './tasks/implementation/codex-continuation-native.ts';
import { codexDispatchNative, type DispatchNativeThread } from './codex-dispatch-native.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import connectCodexFeedback from './tasks/feedback/codex-feedback-client.ts';
import { selectCodexTaskContext } from './tasks/context/codex-task-context.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { feedbackConversationMode } from './tasks/feedback/feedback-conversation-mode.ts';
import { feedbackInputContext } from './tasks/feedback/feedback-input.ts';
import authorizeFeedback from './tasks/feedback/feedback-source-context.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import { dispatchAdmission, managedTargetUrl } from './managed-issue.ts';
import taskPullRequest from './tasks/delivery/task-pull-request.ts';
import taskTurnContext from './task-turn-context.ts';
import workflowFailure from './workflow-failure.ts';
type Turn = {
  threadId: string;
  turnId?: string;
};
type Lookup = {
  find: ReturnType<typeof codexDispatchNative>['find'];
  receipt: ReturnType<typeof codexContinuationNative>;
};
/** verify native creation custody, including a child that starts before coordinator readback. */
export async function selectCodexTaskOwner(
  records: readonly DispatchRecord[],
  threadId: string,
  find: Lookup['find'],
) {
  const owners = records.filter(
    (record) => record.threadId === threadId && !record.reset && !record.supersededBy,
  );
  if (owners.length > 1) throw new Error('turn-context-owner-ambiguous');
  const matches: {
    record: DispatchRecord;
    native: DispatchNativeThread;
  }[] = [];
  for (const record of owners.length ? owners : records) {
    if (
      !record.request ||
      record.reset ||
      record.supersededBy ||
      (record.threadId && record.threadId !== threadId)
    )
      continue;
    let native;
    try {
      native = await find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request.prompt,
        createdAfter: record.createdAt,
        threadId: threadId,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'dispatch-native-readback-diverged') continue;
      throw error;
    }
    if (!native || native.id !== threadId) continue;
    matches.push({ record, native });
  }
  if (matches.length > 1) throw new Error('turn-context-owner-ambiguous');
  if (!matches.length) {
    if (owners.length) throw new Error('turn-context-owner-unverified');
    return;
  }
  return matches[0];
}
/** resolve hints through native creation and send receipts, never provider text. */
export async function selectCodexTurnTask(
  records: readonly DispatchRecord[],
  turn: Turn,
  lookup: Lookup,
) {
  const owner = await selectCodexTaskOwner(records, turn.threadId, lookup.find);
  if (!owner) return;
  const { record, native } = owner;
  const turnId = turn.turnId ?? native.turnId;
  if (!turnId) throw new Error('turn-context-native-turn-unavailable');
  const feedback = [];
  let unresolvedFeedback = false;
  let currentFeedbackUnresolved = false;
  let feedbackLimitation:
    | {
        code: string;
      }
    | undefined;
  for (const event of record.feedback?.events ?? []) {
    if (
      !event.attempt ||
      event.attempt.request.threadId !== turn.threadId ||
      (event.attempt.turnId && event.attempt.turnId !== turnId)
    )
      continue;
    try {
      const receipt = await lookup.receipt(record.sourceThreadId, event.attempt);
      if (receipt.status === 'verified' && receipt.turnId === turnId) {
        feedback.push(event);
      } else if (receipt.status !== 'verified') {
        if ('turnId' in receipt && receipt.turnId && receipt.turnId !== turnId) continue;
        unresolvedFeedback = true;
        currentFeedbackUnresolved ||=
          event.attempt.turnId === turnId || ('turnId' in receipt && receipt.turnId === turnId);
        if ('code' in receipt && receipt.code) feedbackLimitation = { code: receipt.code };
      }
    } catch (error) {
      unresolvedFeedback = true;
      currentFeedbackUnresolved ||= event.attempt.turnId === turnId;
      feedbackLimitation = {
        code: workflowFailure(error, 'feedback-native-input-unavailable').code,
      };
    }
  }
  const source = !currentFeedbackUnresolved && feedback.length === 1 ? feedback[0] : undefined;
  if (source) feedbackLimitation = undefined;
  else if (feedback.length > 1) feedbackLimitation = { code: 'feedback-native-input-ambiguous' };
  const implementation = Boolean(retainedIssueProgression(record));
  return {
    currentTurn: { threadId: turn.threadId, turnId },
    receipt: record.id,
    stage:
      feedback.length || unresolvedFeedback
        ? 'feedback'
        : implementation
          ? 'implementation'
          : 'assessment',
    contextRequest: !feedback.length && !unresolvedFeedback ? { action: 'context' } : undefined,
    contextRuntime: implementation ? 'continuationRuntime' : 'dispatchRuntime',
    feedbackContextRequest: source && { action: 'context', id: record.id, eventId: source.id },
    ...(feedbackLimitation ? { feedbackLimitation } : {}),
    worktree: record.worktree ?? native.cwd,
    nativeCwd: native.cwd,
    pullRequest: taskPullRequest(record),
    branch: record.issueBranch?.name,
  };
}
/** read the bound journal and native receipts without discovery, reconciliation, or writes. */
export function readCodexTaskOwner(pluginData: string, turn: Turn) {
  return withDispatchTask('codex', turn.threadId, () => readScopedTaskOwner(pluginData, turn));
}
async function readScopedTaskOwner(pluginData: string, turn: Turn) {
  const current = await selectCodexTaskContext(
    pluginData,
    {},
    { resolvePolicy: false, inspectionOnly: true },
  );
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const records = (await journal.read()).records;
  if (
    !records.some(
      (record) => record.threadId === turn.threadId || (!record.threadId && record.request),
    )
  )
    return;
  const connection = await connectCodexThreads(current.workspace, current.codexHome);
  try {
    const selected = await selectCodexTurnTask(records, turn, {
      find: codexDispatchNative(connection.request).find,
      receipt: codexContinuationNative(connection.request),
    });
    const record = selected && records.find((record) => record.id === selected.receipt);
    return (
      selected &&
      record && {
        ...selected,
        record,
        manifest: current.manifest,
        workspace: current.workspace,
        codexHome: current.codexHome,
        admission: dispatchAdmission(record, (await current.store.read())?.records ?? []),
        git: { protocol: resolveGitProtocol(current.manifest) },
      }
    );
  } finally {
    await connection.close();
  }
}
/** hooks and explicit recovery share one read-only native context owner. */
export default async function readCodexTurnTask(
  pluginData: string,
  turn: Turn,
  deps: {
    owner?: typeof readCodexTaskOwner;
    connect?: typeof connectCodexThreads;
    feedbackConnect?: typeof connectCodexFeedback;
    skill?: typeof codexAssessmentSkill;
  } = {},
) {
  const readOwner = deps.owner ?? readCodexTaskOwner;
  const owner = await readOwner(pluginData, turn);
  if (!owner) return;
  if (!owner.admission) throw new Error('turn-context-admission-unavailable');
  const { record, admission, manifest, workspace } = owner;
  const facts = omit(owner, [
    'record',
    'admission',
    'manifest',
    'workspace',
    'codexHome',
    'contextRequest',
    'contextRuntime',
    'feedbackContextRequest',
  ]);
  const assertCurrent = async () => {
    const next = await readOwner(pluginData, turn);
    if (next?.receipt !== owner.receipt || next.currentTurn.turnId !== owner.currentTurn.turnId)
      throw new Error('turn-context-native-caller-changed');
  };
  let connection: ReturnType<typeof connectCodexThreads> | undefined;
  const connect = () =>
    (connection ??= (deps.connect ?? connectCodexThreads)(workspace, owner.codexHome));
  try {
    const selected =
      owner.feedbackContextRequest &&
      record.feedback?.events.find((event) => event.id === owner.feedbackContextRequest!.eventId);
    let feedback;
    let feedbackLimitation = owner.feedbackLimitation;
    try {
      if (owner.stage === 'feedback' && !selected)
        feedbackLimitation ??= { code: 'feedback-native-input-unverified' };
      if (selected) {
        const provider = await (deps.feedbackConnect ?? connectCodexFeedback)(
          workspace,
          new AbortController().signal,
        );
        await authorizeFeedback({
          conversation: true,
          record: {},
          event: selected,
          intake: admission,
          policy: manifest.github!.notifications!,
          provider: {
            identity: provider.comments.identity,
            reviews: provider.comments.reviews,
            getItem: provider.client.getItem.bind(provider.client),
            getIssueComment: provider.comments.getIssueComment.bind(provider.comments),
          },
          assertCurrent,
        });
        feedback = feedbackInputContext({
          event: selected,
          repository: `${admission.repository.owner.login}/${admission.repository.name}`,
          mode: feedbackConversationMode(record, manifest.github!.notifications!),
          issueStage: retainedIssueProgression(record)?.stage ?? 'planning',
          self: JSON.parse(selected.source).author?.nodeId === provider.comments.identity.nodeId,
        });
      }
    } catch (error) {
      feedbackLimitation = { code: workflowFailure(error, 'feedback-context-unavailable').code };
    }
    const context = await taskTurnContext({
      runtime: 'codex',
      manifest,
      workspace,
      record: { ...record, worktree: facts.worktree },
      target: managedTargetUrl(admission),
      stage: owner.stage,
      feedback,
      feedbackLimitation,
      resolveSkill: deps.skill
        ? async (id) => deps.skill!((await connect()).request, facts.worktree ?? workspace, id)
        : codexSkillResolver(
            async (method, params) => (await connect()).request(method, params),
            facts.worktree ?? workspace,
          ),
    });
    await assertCurrent();
    return { ...facts, ...context };
  } finally {
    if (connection)
      await connection.then(
        (value) => value.close(),
        () => {},
      );
  }
}
