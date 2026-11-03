import assert from 'node:assert/strict';

import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import GitHubAssignmentClaimClient from '../channels/github/provider/assignment-claim-client.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import type selectionFixture from './project-pickup-selection-fixture.ts';

/** real provider verification and claim storage with an isolated comment transport. */
export default function pickupClaims(
  f: ReturnType<typeof selectionFixture>,
  root: string,
  comments: GitHubCanonicalIssueComment[] = [],
) {
  const provider = new GitHubWorkEventClient({
    identity: f.client.identity,
    execute: async () => {
      throw new Error('unexpected external request');
    },
  });
  provider.getRepository = (...args) => f.tx.client.getRepository(...args);
  provider.getItem = (...args) => f.tx.client.getItem(...args);
  provider.listAssignmentEvents = (...args) => f.tx.client.listAssignmentEvents(...args);
  const client = new GitHubAssignmentClaimClient(provider);
  const effects = { creates: 0, updates: 0, removes: 0, responseLost: false };
  client.list = async () => structuredClone(comments);
  client.create = async (source, body) => {
    await client.verify(source);
    effects.creates++;
    const id = Math.max(0, ...comments.map((comment) => comment.databaseId)) + 1;
    comments.push({
      author: { ...f.client.identity, type: 'User' },
      body,
      bodyTruncated: false,
      databaseId: id,
      nodeId: `C_${id}`,
      createdAt: new Date(f.clock.now).toISOString(),
      updatedAt: new Date(f.clock.now).toISOString(),
    });
    if (effects.responseLost)
      throw new GitHubWorkEventClientError('github-unavailable', 'response lost');
    return id;
  };
  client.update = async (source, id, previous, body) => {
    await client.verify(source);
    const comment = comments.find((entry) => entry.databaseId === id)!;
    assert.equal(comment.body, previous);
    effects.updates++;
    comment.body = body;
  };
  client.remove = async (source, id, previous) => {
    await client.verify(source);
    const index = comments.findIndex((entry) => entry.databaseId === id);
    assert.equal(comments[index]!.body, previous);
    comments.splice(index, 1);
    effects.removes++;
  };
  f.tx.claims = { store: new AssignmentClaimStore(root), client, passId: 'first' };
  return { client, comments, effects, provider, store: f.tx.claims.store };
}
