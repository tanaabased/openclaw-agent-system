import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';

import { automationHash } from './automation-hash.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import redactFeedback from './feedback-redaction.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationInput,
} from '../channels/github/publication/comment-publisher.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication-contract.ts';
import type IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import type { IssueDeliveryInput } from '../channels/github/publication/issue-delivery.ts';
import type { GitHubNotificationPublicationClient } from '../channels/github/provider/work-event-client.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { githubCommentCard } from '../channels/github/presentation/comment.ts';
import publicResponsePresentation from '../channels/github/presentation/public-response.ts';
import publicResponse from './public-response.ts';

type CommentClient = Pick<
  GitHubNotificationPublicationClient,
  'findOwnIssueComment' | 'createIssueComment'
>;
type Delivery = { announcement?: DeliveryAnnouncementState };

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
  const publisher = new GitHubNotificationCommentPublisher({
    redactText: redactFeedback,
    authorize: () => ({ authorized: true }),
    connect: () => ({ client: input.client }),
    exclusive: async (_key, run) => run(),
  });
  const found = await publisher.reconcile(announcementPublication(input.state, input.item));
  if (!found || (input.state.receipt && found.receipt.nodeId !== input.state.receipt.nodeId))
    throw new Error('delivery-announcement-unconfirmed');
  return { nodeId: found.receipt.nodeId, databaseId: found.receipt.databaseId };
}

export function announcementPresentation(
  state: DeliveryAnnouncementState | undefined,
  issueUrl: string,
  authorLogin = state?.authorLogin,
) {
  const confirmed = state?.receipt && !state.code;
  const quote = state?.publicText
    ? githubCommentCard({
        body: state.publicText,
        author: authorLogin
          ? { label: authorLogin, url: `https://github.com/${encodeURIComponent(authorLogin)}` }
          : undefined,
        label: 'PR announcement',
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
        code: state?.code,
      });
  return [quote, obstacle].filter(Boolean).join('\n\n');
}

/** Recovery resumes only the announcement phase that has not finished. */
export function announcementRecoveryInstructions(state?: DeliveryAnnouncementState) {
  if (state?.receipt && !state.code)
    return 'The originating-issue announcement is confirmed. Keep its receipt; no announcement operation remains.';
  if (state?.attempted || state?.receipt)
    return 'Call delivery announce to reconcile the retained announcement attempt. Do not compose or post a replacement.';
  return 'Call delivery compose, invoke the selected reply skill, submit candidate, then execute announce with its preview digest.';
}

/** native attachment is the only host-specific step after verified publication. */
export function deliveryCompletionInstructions(
  runtime: 'codex' | 'openclaw',
  delivery: Delivery & { attached?: boolean },
) {
  const attachment =
    runtime === 'openclaw'
      ? ''
      : delivery.attached
        ? 'Native PR attachment is confirmed. '
        : 'Call native attach_artifact for this pull_request URL, then list_artifacts and delivery reconcile. ';
  return (
    attachment +
    announcementRecoveryInstructions(delivery.announcement) +
    ' Then call delivery present and reproduce its complete private PR card and announcement outcome. Continue in this same turn; an attachment, announcement, or card failure never requires recreating the PR. ' +
    (runtime === 'codex'
      ? 'For automatic workflows, use continuationRuntime action:delivery with the nested delivery operation.'
      : 'Use agent_system_dispatch action delivery with the requested operation.')
  );
}

/** the native delivery owner supplies authority and serializes state with the PR receipt. */
export default async function deliveryAnnouncement(input: {
  operation: 'compose' | 'candidate' | 'announce';
  digest?: string;
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
  try {
    await input.authorize();
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
      delivery.announcement = current;
      await input.save();
      return {
        status: 'composition-ready',
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
          'Invoke the selected reply skill with this public delivery event and applicable voice guidance. Return only a short description of what the PR delivers; the host adds its verified link and draft/ready state. Do not claim tests, approval or merge or expose private context. Submit delivery candidate with this digest and publicText, then inspect its exact preview and call announce with the returned digest through native approval. Missing skills stop composition. If skill content or guidance changes before publication is attempted, call compose again and replace the candidate; an uncertain write must be reconciled without reposting. Keep the full private PR card even if announcing fails.',
      };
    }
    const state = delivery.announcement;
    if (!state || automationHash({ ...state, publicText: undefined, code: undefined }) !== digest)
      throw new Error('delivery-announcement-stale');
    if (input.operation === 'candidate') {
      if (input.digest !== digest) throw new Error('delivery-announcement-stale');
      if (!input.publicText?.trim() || input.publicText.length > 500)
        throw new Error('delivery-announcement-description-required');
      state.publicText = githubNotificationPublicationText(
        'pull-request-handoff',
        [
          {
            text: `${input.publicText.trim()}\n\n[PR #${snapshot.pullRequestNumber}](https://github.com/${repository}/pull/${snapshot.pullRequestNumber}) — ${snapshot.draft ? 'Draft' : 'Ready for review'}.`,
          },
        ],
        redactFeedback,
      );
      delete state.code;
      await input.save();
    }
    const prepared = announcementPublication(state, item);
    const previewDigest = automationHash({ ...current, publicText: state.publicText });
    if (input.operation === 'candidate' || input.digest === undefined)
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
          'Publish this exact announcement using delivery announce with this digest through native approval. Existing managed-delivery authority covers only this issue/PR announcement; stop on denial. Afterwards present the full private PR card and announcement outcome.',
      };
    if (input.digest !== previewDigest) throw new Error('delivery-announcement-stale');
    const result = await publicResponse({
      publication: prepared,
      attempted: state.attempted,
      receipt: state.receipt,
      setAttempted: (attempted) => {
        state.attempted = attempted;
      },
      setReceipt: (receipt) => {
        state.receipt = receipt;
      },
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
    if (isFilesystemAccessError(error) || (error instanceof Error && error.name === 'AbortError'))
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
      await input.save();
    }
    return {
      status: 'announcement-blocked',
      code,
      presentation: announcementPresentation(
        state,
        issueUrl,
        input.authorLogin ?? state?.authorLogin,
      ),
      instruction:
        'The delivered PR is retained. Present its full private card and this announcement obstacle. Stop on denial or lost authority. On an authorized retry, compose again for a pre-write failure or announce to reconcile an uncertain write; never recreate the PR.',
    };
  }
}
