import type { GitHubNotificationCommentPublicationInput } from '../channels/github/publication/comment-publisher.ts';
import { automationHash } from './automation-hash.ts';
import publicResponse, { type PublicResponseReceipt } from './public-response.ts';

export interface TaskUpdateDraft {
  publicText?: string;
  publication?: string;
  attempted?: boolean;
  receipt?: PublicResponseReceipt;
}

type Publication = Parameters<typeof publicResponse>[0];
type Request =
  | { operation: 'candidate'; text: string; digest?: string; expectedDigest: string }
  | { operation: 'publish' | 'reconcile'; digest?: string; expectedDigest: string };

/** native callers own authority and storage; this operation owns the exact pending write. */
export default async function taskUpdate(input: {
  request: Request;
  draft: TaskUpdateDraft;
  publication(text: string): GitHubNotificationCommentPublicationInput;
  save(): Promise<void>;
  dependencies?: Publication['dependencies'];
  beforeCreate?: Publication['beforeCreate'];
}) {
  const { request, draft } = input;
  const settled = Boolean(draft.attempted || draft.receipt);
  if (request.operation === 'candidate') {
    if (settled) throw new Error('task-update-already-attempted');
    if (request.digest !== request.expectedDigest) throw new Error('task-update-stale');
    if (!request.text.trim()) throw new Error('task-update-candidate-required');
    if (draft.publicText && draft.publicText !== request.text)
      throw new Error('task-update-candidate-conflict');
    const publication = JSON.stringify(input.publication(request.text));
    if (draft.publication && draft.publication !== publication)
      throw new Error('task-update-destination-changed');
    draft.publicText = request.text;
    draft.publication = publication;
    await input.save();
    return { status: 'candidate-recorded' as const };
  }
  if (!draft.publicText) throw new Error('task-update-candidate-required');
  if (!input.dependencies) throw new Error('task-update-publisher-required');
  if (request.operation === 'reconcile' && !settled) throw new Error('task-update-unattempted');
  if (request.operation === 'publish' && request.digest !== request.expectedDigest)
    throw new Error('task-update-stale');
  const publication = input.publication(draft.publicText);
  if (!draft.publication) throw new Error('task-update-publication-required');
  const retained = JSON.parse(draft.publication) as GitHubNotificationCommentPublicationInput;
  if (automationHash(retained) !== automationHash(publication))
    throw new Error('task-update-destination-changed');
  return publicResponse({
    publication: retained,
    attempted: Boolean(draft.attempted),
    receipt: draft.receipt,
    reconcileOnly: request.operation === 'reconcile',
    setAttempted: (attempted) => {
      draft.attempted = attempted;
    },
    setReceipt: (receipt) => {
      draft.receipt = receipt;
    },
    save: input.save,
    beforeCreate: input.beforeCreate,
    dependencies: input.dependencies,
  });
}
