import { cardCopyInstructions } from '../channels/github/presentation/card.ts';
import replyMaterial from './reply-material.ts';
import type { ImplementationMaterialRead } from './implementation-material.ts';
import taskUpdateInstructions from './task-update-instructions.ts';
import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';

import { automationHash } from './automation-hash.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import {
  announcementBinding,
  announcementRecoveryAction,
  retainedAnnouncementPublication,
  retainAnnouncementFailure,
  type AnnouncementDelivery,
  type AnnouncementRecovery,
} from './delivery-announcement-recovery.ts';
import type { ManagedIssue } from './managed-issue.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import GitHubIssueCommentClient from '../channels/github/provider/issue-comment-client.ts';
import GitHubWorkEventApiClient, {
  GitHubWorkEventClientError,
} from '../channels/github/provider/work-event-api-client.ts';
import redactFeedback from './feedback-redaction.ts';
import type { GitHubNotificationCommentPublicationInput } from '../channels/github/publication/comment-publisher.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication-contract.ts';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../channels/github/publication/issue-delivery.ts';
import type { GitHubNotificationPublicationClient } from '../channels/github/provider/work-event-client.ts';
import { githubCommentCard } from '../channels/github/presentation/comment.ts';
import publicResponsePresentation from '../channels/github/presentation/public-response.ts';
import taskUpdate from './task-update.ts';

type CommentClient = Pick<
  GitHubNotificationPublicationClient,
  'findOwnIssueComment' | 'createIssueComment'
>;
type Delivery = AnnouncementDelivery;

export function announcementPublication(
  state: DeliveryAnnouncementState,
  item: GitHubNotificationCommentPublicationInput['item'],
): GitHubNotificationCommentPublicationInput {
  if (!state.publicText) throw new Error('delivery-announcement-candidate-required');
  return {
    intent: 'pull-request-handoff',
    item,
    publicationId: state.publicationId,
    text: state.publicText,
  };
}

/** reconciliation is read-only; absence after an attempted write never permits another post. */
export async function reconcileAnnouncement(input: {
  state: DeliveryAnnouncementState;
  item: GitHubNotificationCommentPublicationInput['item'];
  client: CommentClient;
  authorId: string;
}) {
  if (input.state.authorId !== input.authorId)
    throw new Error('delivery-announcement-author-changed');
  const draft = { ...input.state };
  const result = await taskUpdate({
    request: { operation: 'reconcile', expectedDigest: '' },
    draft,
    publication: (text) => ({ ...announcementPublication(input.state, input.item), text }),
    save: async () => {},
    dependencies: {
      redactText: redactFeedback,
      authorize: () => ({ authorized: true }),
      connect: () => ({ client: input.client }),
      exclusive: async (_key, run) => run(),
    },
  });
  if (result.status !== 'published') throw new Error('delivery-announcement-unconfirmed');
  return result.receipt;
}

/** compare verified publication evidence, never a planned or merely local head. */
export function announcementPrecedesDelivery(
  delivery:
    | {
        reconciled: boolean;
        pushedHead?: string;
        pullRequest?: { pullRequestNodeId: string; pullRequestNumber: number };
        announcement?: DeliveryAnnouncementState;
      }
    | undefined,
): boolean {
  const snapshot = delivery?.announcement?.snapshot;
  return Boolean(
    delivery?.reconciled &&
    delivery.pushedHead &&
    snapshot &&
    delivery.pullRequest?.pullRequestNodeId === snapshot.pullRequestNodeId &&
    delivery.pullRequest.pullRequestNumber === snapshot.pullRequestNumber &&
    delivery.pushedHead !== snapshot.head,
  );
}

export function announcementPresentation(
  state: DeliveryAnnouncementState | undefined,
  issueUrl: string,
  authorLogin = state?.authorLogin,
  recovery?: AnnouncementRecovery,
  updatedSinceAnnouncement = false,
) {
  const confirmed = state?.receipt && !state.code && !recovery;
  const quote = state?.publicText
    ? githubCommentCard({
        body: state.publicText,
        author: authorLogin
          ? { label: authorLogin, url: `https://github.com/${encodeURIComponent(authorLogin)}` }
          : undefined,
        label: confirmed ? 'Original PR announcement' : 'PR announcement',
        connector: 'by',
        publication: confirmed
          ? { url: `${issueUrl}#issuecomment-${state.receipt!.databaseId}` }
          : { draft: true },
      })
    : '';
  const obstacle = confirmed
    ? ''
    : publicResponsePresentation({
        kind: 'PR announcement',
        destination: issueUrl,
        attempted: state?.attempted,
        receipt: state?.receipt,
        code: recovery?.code ?? state?.code,
      });
  const heldNext =
    recovery?.code === 'delivery-announcement-candidate-required'
      ? state?.attempted || state?.receipt
        ? 'Reconcile the retained announcement attempt; do not compose or post a replacement.'
        : 'No announcement write was attempted. Compose and retain the announcement candidate, then continue with its preview.'
      : recovery?.code === 'github-delivery-linkage-unverified' ||
          recovery?.code === 'delivery-announcement-unconfirmed'
        ? 'Check the existing PR’s closing association, then explicitly continue in this chat.'
        : ['authentication', 'permission', 'missing-credential'].includes(
              recovery?.providerDiagnostic?.classification ?? '',
            )
          ? 'Restore the indicated GitHub access, then explicitly continue in this chat.'
          : 'Inspect the retained diagnostic and correct that specific obstacle before explicitly continuing in this chat.';
  const next = recovery
    ? recovery.status === 'retrying'
      ? `> **Recovery:** Scheduled read-only check after ${new Date(recovery.retryAfter!).toISOString()}; no delivery model turn while the prerequisite remains unverified.`
      : `> **Recovery:** ${recovery.status === 'exhausted' ? 'Automatic checks exhausted.' : 'Automatic recovery is held.'} ${heldNext} Do not bypass a native denial or create a replacement PR.`
    : '';
  return [
    confirmed && updatedSinceAnnouncement && quote
      ? 'Original announcement (before this update):'
      : '',
    quote,
    obstacle,
    next,
    recovery?.providerDiagnostic
      ? `> **Provider:** ${recovery.providerDiagnostic.explanation}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** scheduled recovery checks retained intent without a composer, publication, or synthetic native turn. */
export async function recheckAnnouncement(
  input: Pick<
    Parameters<typeof deliveryAnnouncement>[0],
    'delivery' | 'publication' | 'provider' | 'client' | 'authorId' | 'authorize' | 'save'
  > & { now: number },
) {
  if (announcementRecoveryAction(input.delivery, input.now) !== 'check') return false;
  try {
    await input.authorize();
    if (
      input.delivery.announcementRecovery &&
      input.delivery.announcementRecovery.binding !== announcementBinding(input.publication)
    )
      throw new Error('delivery-announcement-binding-changed');
    const state = input.delivery.announcement;
    if (state?.attempted || state?.receipt) {
      const item = {
        lifecycleId: input.publication.adoptedPullRequest
          ? ('pull-request' as const)
          : ('issue' as const),
        number: input.publication.item.number,
        repositoryOwner: input.publication.item.repositoryOwner,
        repositoryName: input.publication.item.repositoryName,
        repositoryNodeId: input.publication.repositoryNodeId!,
      };
      state.receipt = await reconcileAnnouncement({
        state,
        item,
        client: input.client,
        authorId: input.authorId,
      });
    } else {
      await input.provider.announcement(input.publication);
    }
    await input.authorize();
    delete input.delivery.announcementRecovery;
    if (state) delete state.code;
    await input.save();
    return true;
  } catch (error) {
    if (
      error instanceof WorkflowPolicyHeld ||
      isFilesystemAccessError(error) ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    retainAnnouncementFailure(
      input.delivery,
      input.publication,
      error,
      input.now,
      input.delivery.announcement?.attempted ? 'response' : 'prerequisite',
    );
    await input.save();
    return false;
  }
}

export async function recoverRetainedAnnouncement(input: {
  delivery: AnnouncementDelivery & Parameters<typeof retainedAnnouncementPublication>[1];
  intake: ManagedIssue;
  now: number;
  signal?: AbortSignal;
  connect(): Promise<{ account: IssueDeliveryProvider['client'] }>;
  authorize(): Promise<void>;
  save(): Promise<void>;
}) {
  if (announcementRecoveryAction(input.delivery, input.now) !== 'check') return false;
  const publication = retainedAnnouncementPublication(input.intake, input.delivery, input.signal);
  try {
    await input.authorize();
    const { account } = await input.connect();
    if (account.identity.nodeId !== input.intake.receiving.nodeId)
      throw new Error('delivery-account-changed');
    return await recheckAnnouncement({
      ...input,
      publication,
      provider: new IssueDeliveryProvider(account),
      client: new GitHubIssueCommentClient(new GitHubWorkEventApiClient(account), 8000),
      authorId: account.identity.nodeId,
    });
  } catch (error) {
    if (
      error instanceof WorkflowPolicyHeld ||
      isFilesystemAccessError(error) ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    retainAnnouncementFailure(input.delivery, publication, error, input.now, 'prerequisite');
    await input.save();
    return false;
  }
}

/** Recovery resumes only the announcement phase that has not finished. */
export function announcementRecoveryInstructions(
  state?: DeliveryAnnouncementState,
  recovery?: AnnouncementRecovery,
) {
  if (recovery)
    return `Announcement recovery is ${recovery.status}. Do not repeat the failed step in this turn. Automatic checks respect retained eligibility; held or exhausted recovery requires explicit same-chat continuation after correcting the obstacle. Native denials remain stopped.`;
  if (state?.receipt && !state.code)
    return 'The originating-issue announcement is confirmed. Keep its receipt; no announcement operation remains.';
  if (state?.attempted || state?.receipt)
    return 'Call delivery announce to reconcile the retained announcement attempt. Do not compose or post a replacement.';
  if (state?.publicText)
    return 'Call delivery announce through native approval to verify and publish the saved draft. Preserve the draft; do not compose a replacement merely to resume delivery. A stale snapshot or changed reply skill requires fresh composition before any write.';
  return 'Call delivery compose, invoke the selected reply skill, submit candidate, then execute announce through native approval.';
}

/** native attachment is the only host-specific step after verified publication. */
export function deliveryCompletionInstructions(
  runtime: 'codex' | 'openclaw',
  delivery: Delivery & { attached?: boolean },
  updated = false,
) {
  const attachment =
    runtime === 'openclaw'
      ? ''
      : delivery.attached
        ? 'Native PR attachment is confirmed. '
        : 'Call native attach_artifact for this pull_request URL, then list_artifacts and delivery reconcile. ';
  return (
    cardCopyInstructions +
    ' ' +
    (updated
      ? ''
      : 'Submit the complete returned linkRequest for the initial task/PR association; follow its native attachment instructions and reuse that request for attachment readback. ') +
    attachment +
    (updated
      ? 'This delivery updated the existing PR. Invoke Task Update for its material verified changes as a separate publication, coalescing any source-bound reply that already conveys them. An update failure does not undo delivery or prevent card presentation. '
      : '') +
    taskUpdateInstructions() +
    ' ' +
    announcementRecoveryInstructions(delivery.announcement, delivery.announcementRecovery) +
    ' When an admitted feedback request is on the announcement destination, include its completion answer in the announcement and reuse that confirmed comment as the reply. Do not publish a separate done/PR-ready reply with the same information. Different destinations or distinct unanswered questions still need their own source-bound replies. Then call delivery present and reproduce its complete private PR card and announcement outcome. Attempt these steps in this turn; retain any specific failure without reopening implementation or preparing a generic resume. Never recreate the verified PR. ' +
    (runtime === 'codex'
      ? 'Use deliveryRuntime directly for these independent external effects; no conversation phase changes.'
      : 'Use agent_system_dispatch action delivery with the requested operation.')
  );
}

/** the native delivery owner supplies authority and serializes state with the PR receipt. */
export default async function deliveryAnnouncement(input: {
  operation: 'compose' | 'candidate' | 'announce';
  runtime: 'codex' | 'openclaw';
  request: Record<string, unknown>;
  material?: ImplementationMaterialRead;
  now?: number;
  publicText?: string;
  delivery: Delivery;
  publication: IssueDeliveryInput;
  provider: Pick<IssueDeliveryProvider, 'announcement'>;
  client: CommentClient;
  authorId: string;
  authorLogin?: string;
  select(state?: DeliveryAnnouncementState): Promise<DeliveryAnnouncementState['composition']>;
  authorize(): Promise<void>;
  save(): Promise<void>;
}) {
  const { delivery, publication } = input;
  const repository = `${publication.item.repositoryOwner}/${publication.item.repositoryName}`;
  const issueUrl = `https://github.com/${repository}/${publication.adoptedPullRequest ? 'pull' : 'issues'}/${publication.item.number}`;
  const item = {
    lifecycleId: publication.adoptedPullRequest ? ('pull-request' as const) : ('issue' as const),
    number: publication.item.number,
    repositoryOwner: publication.item.repositoryOwner,
    repositoryName: publication.item.repositoryName,
    repositoryNodeId: publication.repositoryNodeId!,
  };
  let posting = false;
  let prerequisite = true;
  try {
    await input.authorize();
    if (
      input.material &&
      (input.operation !== 'compose' ||
        delivery.announcement?.attempted ||
        delivery.announcement?.receipt)
    )
      throw new Error('delivery-announcement-material-unavailable');
    if (delivery.announcement?.attempted || delivery.announcement?.receipt) {
      const state = delivery.announcement;
      state.receipt = await reconcileAnnouncement({
        state,
        item,
        client: input.client,
        authorId: input.authorId,
      });
      if (input.authorLogin) state.authorLogin = input.authorLogin;
      delete state.code;
      delete delivery.announcementRecovery;
      await input.save();
      return {
        status: 'announced',
        receipt: state.receipt,
        presentation: announcementPresentation(
          state,
          issueUrl,
          input.authorLogin ?? state?.authorLogin,
        ),
      };
    }
    const snapshot = await input.provider.announcement(publication);
    prerequisite = false;
    const composition = await input.select(delivery.announcement);
    const publicationId = automationHash([
      publication.repositoryNodeId,
      publication.item.itemNodeId,
      snapshot.pullRequestNodeId,
    ]);
    const current: DeliveryAnnouncementState = {
      publicationId,
      authorId: input.authorId,
      snapshot,
      composition,
      attempted: false,
    };
    const digest = automationHash(current);
    if (input.operation === 'compose') {
      // a fresh provider snapshot replaces only an unattempted candidate.
      if (input.material) {
        if (
          !delivery.announcement ||
          automationHash({
            ...delivery.announcement,
            publicText: undefined,
            code: undefined,
            publication: undefined,
          }) !== digest
        )
          throw new Error('delivery-announcement-material-stale');
      } else {
        delivery.announcement = current;
        delete delivery.announcementRecovery;
        await input.save();
      }
      return replyMaterial(
        {
          runtime: input.runtime,
          status: 'composition-ready' as const,
          destination: issueUrl,
          digest,
          selection: composition,
          event: {
            kind: 'pull-request-delivery',
            title: snapshot.title,
            body: snapshot.body,
            draft: snapshot.draft,
            url: `https://github.com/${repository}/pull/${snapshot.pullRequestNumber}`,
          },
          maximumPublicCharacters: 500,
          instruction:
            'Invoke the selected reply skill with this public delivery event and applicable voice guidance. Return only a short description of what the PR delivers; the host adds its verified link and draft/ready state. If this also answers an admitted feedback request on this destination, include its answer and source-author attribution in this one comment; reuse its confirmed text and permalink instead of a separate completion reply. Different destinations or distinct unanswered questions still require their own source-bound replies. Do not claim tests, approval or merge or expose private context. Submit delivery candidate with publicText, then inspect its preview and call announce through native approval. Missing skills stop composition. If skill content or guidance changes before publication is attempted, call compose again and replace the candidate; an uncertain write must be reconciled without reposting. Keep the full private PR card even if announcing fails.',
        },
        input.request,
        input.material,
      );
    }
    const state = delivery.announcement;
    if (
      !state ||
      automationHash({
        ...state,
        publicText: undefined,
        code: undefined,
        publication: undefined,
      }) !== digest
    )
      throw new Error('delivery-announcement-stale');
    if (input.operation === 'candidate') {
      if (!input.publicText?.trim() || input.publicText.length > 500)
        throw new Error('delivery-announcement-description-required');
      const text = githubNotificationPublicationText(
        'pull-request-handoff',
        [
          {
            text: `${input.publicText.trim()}\n\n[PR #${snapshot.pullRequestNumber}](https://github.com/${repository}/pull/${snapshot.pullRequestNumber}) — ${snapshot.draft ? 'Draft' : 'Ready for review'}.`,
          },
        ],
        redactFeedback,
      );
      await taskUpdate({
        request: { operation: 'candidate', text, digest, expectedDigest: digest },
        draft: state,
        publication: (text) => ({
          ...announcementPublication({ ...state, publicText: text }, item),
          text,
        }),
        save: input.save,
      });
      delete state.code;
      delete delivery.announcementRecovery;
      await input.save();
    }
    const prepared = announcementPublication(state, item);
    const previewDigest = automationHash({ ...current, publicText: state.publicText });
    if (input.operation === 'candidate')
      return {
        status: 'announcement-prepared',
        digest: previewDigest,
        destination: issueUrl,
        publicText: state.publicText,
        presentation: githubCommentCard({
          body: state.publicText!,
          author: input.authorLogin
            ? {
                label: input.authorLogin,
                url: `https://github.com/${encodeURIComponent(input.authorLogin)}`,
              }
            : undefined,
          label: 'PR announcement',
          connector: 'by',
          publication: { draft: true },
        }),
        instruction:
          'Publish this exact announcement using delivery announce through native approval. Existing managed-delivery authority covers only this issue/PR announcement; stop on denial. Afterwards present the full private PR card and announcement outcome.',
      };
    const result = await taskUpdate({
      request: { operation: 'publish', digest: previewDigest, expectedDigest: previewDigest },
      draft: state,
      publication: (text) => ({ ...prepared, text }),
      save: input.save,
      beforeCreate: async () => {
        await input.authorize();
        if (
          automationHash(await input.provider.announcement(publication)) !==
          automationHash(snapshot)
        )
          throw new Error('delivery-announcement-stale');
        await input.authorize();
        posting = true;
      },
      dependencies: {
        redactText: redactFeedback,
        authorize: async () => {
          await input.authorize();
          return { authorized: true };
        },
        connect: () => ({ client: input.client }),
        exclusive: async (_key, run) => run(),
      },
    });
    if (result.status !== 'published') throw new Error('delivery-announcement-unconfirmed');
    if (input.authorLogin) state.authorLogin = input.authorLogin;
    delete state.code;
    delete delivery.announcementRecovery;
    await input.save();
    return {
      status: 'announced',
      receipt: state.receipt,
      presentation: announcementPresentation(
        state,
        issueUrl,
        input.authorLogin ?? state?.authorLogin,
      ),
    };
  } catch (error) {
    if (input.material) throw error;
    if (
      error instanceof WorkflowPolicyHeld ||
      isFilesystemAccessError(error) ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    const state = delivery.announcement;
    const message =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : '';
    const code = /^(?:delivery|dispatch|continuation|github)-[a-z-]+$/.test(message)
      ? message
      : 'delivery-announcement-failed';
    if (state) {
      const status =
        error instanceof GitHubWorkEventClientError
          ? error.providerDiagnostic?.httpStatus
          : undefined;
      // an explicit rejection proves no comment was accepted; timeouts and ambiguous failures do not.
      if (
        posting &&
        typeof status === 'number' &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        !state.receipt
      )
        state.attempted = false;
      state.code = code;
    }
    retainAnnouncementFailure(
      delivery,
      publication,
      error,
      input.now ?? Date.now(),
      prerequisite ? 'prerequisite' : 'response',
    );
    await input.save();
    return {
      status: 'announcement-blocked',
      code,
      presentation: announcementPresentation(
        state,
        issueUrl,
        input.authorLogin ?? state?.authorLogin,
        delivery.announcementRecovery,
      ),
      instruction:
        'The delivered PR and any draft are retained. Present its full private card and this announcement obstacle, then stop announcement retries in this turn. Automatic recovery uses the retained retry eligibility and bounded budget; held or exhausted recovery needs explicit same-chat continuation after correction. Stop on denial or lost authority. Reconcile an uncertain write without reposting; never recreate the PR.',
    };
  }
}
