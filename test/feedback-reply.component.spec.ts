import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assessmentSkillSource from '../agent/assessment-skill-source.ts';
import feedbackReply, { type FeedbackReplyDependencies } from '../agent/feedback-reply.ts';
import type { OpenClawFeedbackProvider } from '../agent/openclaw-feedback.ts';
import replyOwner, { type ReplyOwner } from '../agent/reply-owner.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import runCodexFeedback from '../agent/codex-feedback.ts';
import type { AgentManifest } from '../manifest/types.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';
import {
  reviewClientFixture,
  reviewCommentFixture,
  reviewFixture,
} from './github-review-fixtures.ts';

const url = 'https://github.com/owner/repo/issues/3';
describe('agent/feedback-reply', () => {
  let root: string, deps: FeedbackReplyDependencies, provider: OpenClawFeedbackProvider;
  let selections: number, writes: number, lost: boolean, hidden: boolean;
  let posted: { nodeId: string; databaseId: number; body: string } | undefined;
  let owners: ReplyOwner[];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'direct-reply-')));
    await writeFile(join(root, 'SKILL.md'), '# ordinary reply composer');
    selections = writes = 0;
    lost = hidden = false;
    posted = undefined;
    owners = [];
    const fixture = intakeFixture();
    provider = {
      ...fixture.client,
      getItemContext: async () => ({
        title: 'issue',
        body: '',
        comments: [],
        labels: [],
        truncated: false,
      }),
      listIssueComments: async () => ({ comments: [], truncated: false }),
      getIssueComment: async (_o, _n, _number, id) => ({
        nodeId: `C_${id}`,
        databaseId: id,
        author: { ...account, login: 'author', nodeId: 'U_author' },
        body: 'A question.',
        bodyTruncated: false,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
      findOwnIssueComment: async (_o, _n, _number, marker) =>
        hidden || !posted?.body.includes(marker) ? undefined : posted,
      createIssueComment: async (_o, _n, _number, body) => {
        writes++;
        posted = { nodeId: 'C_published', databaseId: 9, body };
        if (lost) throw new Error('transport lost');
        return posted;
      },
      replies: {
        create: async () => {
          throw new Error('unexpected inline write');
        },
        find: async () => undefined,
      },
    };
    deps = {
      root: join(root, 'private'),
      binding: {
        runtime: 'openclaw',
        agentId: 'receiver',
        workspace: root,
        namespace: 'test',
        session: 'chat',
        incarnation: 'session',
      },
      turnId: 'turn',
      inputId: 'input',
      manifest: { agent: { id: 'receiver' } } as AgentManifest,
      now: 1,
      provider,
      assertCurrent: async () => {},
      resolveSkill: async (name) => {
        selections++;
        return assessmentSkillSource({ name, path: join(root, 'SKILL.md'), scope: 'user' });
      },
      managed: async (target, purpose) =>
        replyOwner(owners, deps.binding.session, deps.binding.incarnation, target, purpose),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const call = async (operation: string, extra: object = {}) =>
    feedbackReply({ action: 'reply', operation, ...extra }, deps);
  async function candidate(target = url) {
    const composed = await call('compose', {
      target,
      privateText: 'Detailed supplied response.',
      outcome: 'No checks were run.',
    });
    assert.equal(composed.status, 'composition-ready');
    assert.ok('id' in composed && 'digest' in composed);
    await call('candidate', {
      id: composed.id,
      digest: composed.digest,
      publicText: 'Here is the answer. No checks were run.',
    });
    return composed.id;
  }
  async function preview(id: string) {
    const result = await call('publish', { id });
    assert.ok('digest' in result && result.status === 'publication-ready');
    return result.digest;
  }
  const progressFact = {
    key: 'unit-check',
    reference: 'commit:abc',
    revision: 'abc:unit-run-1',
    text: 'The unit checks passed.',
  };
  async function updateContext() {
    const result = await call('context', { purpose: 'status-update', target: url });
    assert.ok('observation' in result && typeof result.observation === 'string');
    return result.observation;
  }
  async function updateCandidate() {
    const result = await call('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Complete private answer.\nPreserve the caveats.',
      update: { observation: await updateContext(), facts: [progressFact] },
    });
    assert.ok('id' in result && 'digest' in result && 'source' in result);
    assert.ok('kind' in result.source && result.source.kind === 'status-update');
    assert.ok('facts' in result.source);
    assert.deepEqual(result.source.facts, [progressFact]);
    assert.equal(result.source.destination, url);
    await call('candidate', {
      id: result.id,
      digest: result.digest,
      publicText: 'Unit checks passed.\n\nNo installed checks ran.',
    });
    return result.id!;
  }
  it('should return current public and retained facts before selecting a status composer and no-op without a draft', async () => {
    const observation = await updateContext();
    assert.equal(selections, 0);
    const result = await call('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Already current.',
      update: { observation, facts: [] },
    });
    assert.equal(result.status, 'already-current');
    assert.equal(selections, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(deps.root), []);
  });
  it('should publish a source-less status update once and keep its full private answer and exact public quote', async () => {
    const id = await updateCandidate();
    deps.turnId = 'later';
    deps.inputId = 'later-input';
    const done = await call('publish', { id, digest: await preview(id) });
    assert.equal(done.status, 'published');
    assert.ok(posted?.body.startsWith('Unit checks passed.\n\nNo installed checks ran.'));
    assert.ok(posted?.body.includes(':status-update:'));
    assert.ok(!posted?.body.includes('@author'));
    assert.ok(
      'presentation' in done &&
        done.presentation?.includes('Complete private answer.\nPreserve the caveats.'),
    );
    assert.ok(
      'presentation' in done &&
        done.presentation?.includes('> Unit checks passed.\n>\n> No installed checks ran.'),
    );
    assert.ok('url' in done && done.url === `${url}#issuecomment-9`);
    assert.ok(
      'presentation' in done &&
        done.presentation?.includes(`https://github.com/${provider.identity.login}`),
    );
    const again = await call('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Reworded private response.',
      update: {
        observation: await updateContext(),
        facts: [{ ...progressFact, text: 'Same verified run, different wording.' }],
      },
    });
    assert.equal(again.status, 'reply-reconciliation-required');
    assert.ok('id' in again && again.id === id);
    await call('reconcile', { id });
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should recover an uncertain status attempt before a different delta without another composer or create', async () => {
    const id = await updateCandidate();
    const digest = await preview(id);
    lost = true;
    const lostResult = await call('publish', { id, digest });
    assert.equal(lostResult.status, 'uncertain');
    hidden = true;
    const pending = await call('context', { purpose: 'status-update', target: url });
    assert.ok('id' in pending && pending.id === id);
    assert.equal(pending.status, 'reply-reconciliation-required');
    const uncertain = await call('reconcile', { id });
    assert.equal(uncertain.status, 'uncertain');
    assert.ok('presentation' in uncertain && !uncertain.presentation?.includes('#issuecomment-9'));
    hidden = false;
    await call('reconcile', { id });
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should withhold a new status update when public facts changed and never substitute a stale observation', async () => {
    const old = await updateContext();
    provider.getItemContext = async () => ({
      title: 'issue',
      body: 'The checks are now public.',
      comments: [],
      labels: [],
      truncated: false,
    });
    await assert.rejects(
      call('compose', {
        purpose: 'status-update',
        target: url,
        privateText: 'Progress.',
        update: { observation: old, facts: [progressFact] },
      }),
      /status-update-observation-changed/,
    );
    const id = await updateCandidate();
    const digest = await preview(id);
    const read = provider.getItemContext;
    provider.getItemContext = async (...args) => ({
      ...(await read(...args)),
      body: 'Newer public facts.',
    });
    const changed = await call('publish', { id, digest });
    assert.equal(changed.status, 'blocked');
    assert.ok('code' in changed && changed.code === 'status-update-observation-changed');
    assert.equal(writes, 0);
  });
  it('should reject incomplete status evidence and invalid or duplicate fact identities before composition', async () => {
    const observation = await updateContext();
    for (const facts of [[{ ...progressFact, key: ' ' }], [progressFact, progressFact]])
      await assert.rejects(
        call('compose', {
          purpose: 'status-update',
          target: url,
          privateText: 'Progress.',
          update: { observation, facts },
        }),
        /status-update-facts-invalid/,
      );
    provider.getItemContext = async () => ({
      title: 'issue',
      body: '',
      comments: [],
      labels: [],
      truncated: true,
    });
    await assert.rejects(updateContext(), /status-update-context-incomplete/);
    assert.equal(selections, 0);
    assert.equal(writes, 0);
  });
  it('should recover pending original publications but allow new status facts after delivered summaries and announcements', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        summary: {},
      },
    ];
    const summary = await call('context', { purpose: 'status-update', target: url });
    assert.ok('route' in summary && summary.route === 'summary');
    owners[0]!.summary!.attempt = 'attempt';
    const uncertain = await call('context', { purpose: 'status-update', target: url });
    assert.ok('operation' in uncertain && uncertain.operation === 'reconcile');
    owners[0]!.summary!.receipt = { nodeId: 'summary' };
    owners[0]!.delivery = {};
    owners[0]!.announcementPending = true;
    const announcement = await call('context', { purpose: 'status-update', target: url });
    assert.ok(
      'route' in announcement &&
        announcement.route === 'delivery' &&
        announcement.operation === 'compose',
    );
    owners[0]!.announcementAttempted = true;
    const attempted = await call('context', { purpose: 'status-update', target: url });
    assert.ok('operation' in attempted && attempted.operation === 'announce');
    owners[0]!.announcementPending = false;
    const context = await call('context', { purpose: 'status-update', target: url });
    assert.ok('entry' in context && context.entry === 'managed');
    assert.equal(selections, 0);
    await updateCandidate();
    assert.equal(selections, 1);
    owners[0]!.inactive = true;
    await assert.rejects(updateContext(), /reply-managed-context-invalid/);
    assert.equal(writes, 0);
  });
  it('should include verified linked pr facts and withhold a candidate after the linked head changes', async () => {
    const originalItem = provider.getItem;
    let head = 'a'.repeat(40);
    provider.getItem = async (owner, name, number) =>
      number === 3
        ? originalItem(owner, name, number)
        : {
            ...intakeFixture().item,
            number,
            itemType: 'pull-request',
            pullRequest: {
              baseRef: 'main',
              headRef: 'topic',
              headSha: head,
              baseRepositoryNodeId: 'R_repo',
              baseRepositoryDatabaseId: 10,
              draft: true,
              merged: false,
            },
          };
    provider.getItemContext = async (_owner, _name, number) => ({
      title: 'Progress',
      body: number === 3 ? 'See https://github.com/owner/repo/pull/4' : 'Linked work.',
      comments: [],
      labels: [],
      truncated: false,
    });
    const read = await call('context', { purpose: 'status-update', target: url });
    assert.ok('publicContext' in read && read.publicContext);
    assert.equal(read.publicContext.pullRequests.length, 1);
    assert.equal(read.publicContext.pullRequests[0]!.item.pullRequest.headSha, head);
    const id = await updateCandidate();
    const digest = await preview(id);
    head = 'b'.repeat(40);
    const result = await call('publish', { id, digest });
    assert.equal(result.status, 'blocked');
    assert.ok('code' in result && result.code === 'status-update-observation-changed');
    assert.equal(writes, 0);
  });
  it('should prepare the default context without automation and reuse its draft without another selection', async () => {
    const id = await candidate();
    assert.equal(writes, 0);
    deps.turnId = 'later-turn';
    deps.inputId = 'later-input';
    const again = await call('compose', {
      target: url,
      privateText: 'Detailed supplied response.',
      outcome: 'No checks were run.',
    });
    assert.equal(again.status, 'candidate-recorded');
    assert.ok('id' in again && again.id === id);
    assert.equal(selections, 1);
    const digest = await preview(id!);
    assert.equal(writes, 0);
    const done = await call('publish', { id, digest });
    assert.equal(done.status, 'published');
    assert.ok(posted?.body.includes('manual-response:'));
    assert.ok(!posted?.body.includes('@author'));
    await call('reconcile', { id });
    assert.equal(writes, 1);
  });
  it('should retain real comment attribution and reject stale candidates and substituted destinations', async () => {
    const composed = await call('compose', {
      target: `${url}#issuecomment-42`,
      privateText: 'Supplied answer.',
    });
    assert.ok('id' in composed && 'digest' in composed && 'factsProvenance' in composed);
    assert.equal(composed.factsProvenance, 'operator-supplied');
    assert.ok('verifiedOutcome' in composed && !composed.verifiedOutcome.assessment);
    await assert.rejects(
      call('candidate', { id: composed.id, digest: 'a'.repeat(64), publicText: 'Answer.' }),
      /reply-composition-stale/,
    );
    await call('candidate', { id: composed.id, digest: composed.digest, publicText: 'Answer.' });
    await assert.rejects(
      call('publish', { id: composed.id, target: 'https://github.com/owner/repo/issues/4' }),
      /reply-target-diverged|reply-source-changed/,
    );
    await call('publish', { id: composed.id, digest: await preview(composed.id!) });
    assert.ok(posted!.body.startsWith('@author\n\nAnswer.'));
    assert.ok(posted!.body.includes('github-reply:'));
    assert.equal(selections, 1);
  });
  it('should stop after an uncertain write and reconcile original text without another create', async () => {
    const id = await candidate();
    const digest = await preview(id!);
    lost = hidden = true;
    await assert.rejects(call('publish', { id, digest }), /transport lost/);
    assert.equal((await call('reconcile', { id })).status, 'uncertain');
    await assert.rejects(
      call('candidate', { id, digest, publicText: 'Different answer.' }),
      /already-attempted/,
    );
    hidden = false;
    await writeFile(join(root, 'SKILL.md'), '# newer composer');
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should reconcile an original comment attempt after the source is edited without recomposing', async () => {
    const id = await candidate(`${url}#issuecomment-42`);
    lost = true;
    await assert.rejects(call('publish', { id, digest: await preview(id!) }), /transport lost/);
    const read = provider.getIssueComment;
    provider.getIssueComment = async (...args) => ({
      ...(await read(...args)),
      body: 'A later edit.',
    });
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should keep admission-only and unrelated workflow edits out of the pinned composition inputs', async () => {
    const id = await candidate();
    deps.manifest.github = {
      notifications: {
        ...intakeFixture().policy,
        issueAssignment: {
          mode: 'work',
          allowed: [],
          feedback: { inherit: false, allowed: [{ login: 'other', nodeId: 'U_other' }] },
        },
      },
    } as AgentManifest['github'];
    assert.equal((await call('publish', { id })).status, 'publication-ready');
    assert.equal(selections, 1);
    assert.equal(writes, 0);
  });
  it('should reject changed source, configuration and skill without silent fallback', async () => {
    const id = await candidate();
    await writeFile(join(root, 'SKILL.md'), '# changed');
    await assert.rejects(call('publish', { id }), /reply-selection-changed/);
    const refreshed = await call('compose', { id });
    assert.equal(refreshed.status, 'composition-ready');
    assert.equal(selections, 2);
    deps.manifest.github = {
      username: 'receiver',
      notifications: {
        ...intakeFixture().policy,
        issueAssignment: {
          allowed: [],
          mode: 'plan',
          feedback: { inherit: true, allowed: [], guidance: { file: 'missing.md' } },
        },
      },
    } as AgentManifest['github'];
    await assert.rejects(call('compose', { id }), /guidance-unreadable/);
    assert.equal(writes, 0);
  });
  it('should share default and custom inline or file guidance across both workflow kinds', async () => {
    await writeFile(join(root, 'guidance.md'), 'Preserve caveats.\nExplain the outcome.');
    for (const workflow of ['issueAssignment', 'reviewRequest'] as const) {
      for (const configuration of [
        {},
        { skill: 'custom:reply' },
        { guidance: 'Inline guidance.\nPreserve uncertainty.' },
        { skill: 'custom:reply', guidance: 'Inline guidance.\nPreserve uncertainty.' },
        { guidance: { file: 'guidance.md' } },
        { skill: 'custom:reply', guidance: { file: 'guidance.md' } },
      ]) {
        const policy = intakeFixture().policy;
        if (workflow === 'issueAssignment')
          policy.issueAssignment = {
            allowed: [],
            mode: 'plan',
            feedback: { inherit: true, allowed: [], ...configuration },
          };
        else
          policy.reviewRequest = {
            allowed: [],
            feedback: { inherit: true, allowed: [], ...configuration },
          };
        deps.manifest.github = { notifications: policy } as AgentManifest['github'];
        if (workflow === 'reviewRequest')
          provider.getItem = async () => ({
            ...intakeFixture().item,
            itemType: 'pull-request',
            pullRequest: {
              baseRef: 'main',
              headRef: 'topic',
              headSha: 'a'.repeat(40),
              baseRepositoryNodeId: 'R_repo',
              baseRepositoryDatabaseId: 10,
              draft: true,
              merged: false,
            },
          });
        const result = await call('compose', {
          target: workflow === 'issueAssignment' ? url : url.replace('/issues/', '/pull/'),
          privateText: JSON.stringify(configuration),
          ...(workflow === 'issueAssignment'
            ? {
                purpose: 'status-update',
                update: {
                  observation: await updateContext(),
                  facts: [{ ...progressFact, key: JSON.stringify(configuration) }],
                },
              }
            : {}),
        });
        assert.ok('selection' in result && result.selection);
        assert.equal(
          result.selection.requestedSkill,
          configuration.skill ?? 'agent-system:agent-system-github-reply',
        );
        assert.equal(
          result.selection.guidance?.content,
          typeof configuration.guidance === 'string'
            ? configuration.guidance
            : configuration.guidance
              ? 'Preserve caveats.\nExplain the outcome.'
              : undefined,
        );
      }
    }
    assert.equal(selections, 12);
  });
  it('should reuse managed owners without resolving another skill and never bypass invalid or foreign owners', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        summary: { receipt: { nodeId: 'existing' } },
        result: {
          version: 1,
          outcome: 'plan-ready',
          summary: 'Retained assessment.',
          assessment: 'Assessment.',
          plan: 'Plan.',
          evidence: [],
          progress: { completed: [], remaining: [] },
        },
      },
    ];
    assert.equal((await call('compose', { target: url })).status, 'managed-reply-required');
    assert.equal(selections, 0);
    assert.equal(writes, 0);
    owners[0]!.inactive = true;
    await assert.rejects(call('compose', { target: url }), /reply-managed-context-invalid/);
    owners[0]!.inactive = false;
    owners[0]!.threadId = 'another-chat';
    await assert.rejects(call('compose', { target: url }), /reply-managed-owner-required/);
  });
  it('should retain inline thread roots and publish only within that thread', async () => {
    const review = reviewFixture();
    const comment = reviewCommentFixture({ replyToId: 71 });
    const parent = reviewCommentFixture({ databaseId: 71, replyToId: 71 });
    const client = reviewClientFixture(review, [comment, parent]);
    provider = { ...provider, reviews: client };
    deps.provider = provider;
    provider.getItem = async () => ({
      ...intakeFixture().item,
      itemType: 'pull-request',
      pullRequest: {
        baseRef: 'main',
        headRef: 'topic',
        headSha: 'a'.repeat(40),
        baseRepositoryNodeId: 'R_repo',
        baseRepositoryDatabaseId: 10,
        draft: true,
        merged: false,
      },
    });
    let rootId: number | undefined;
    provider.replies = {
      create: async (_o, _n, _number, root, body) => {
        rootId = root;
        writes++;
        posted = { databaseId: 9, nodeId: 'inline', body };
        return reviewCommentFixture(posted);
      },
      find: async () => (posted ? reviewCommentFixture(posted) : undefined),
    };
    const id = await candidate(
      `https://github.com/owner/repo/pull/3#discussion_r${comment.databaseId}`,
    );
    await call('publish', { id, digest: await preview(id!) });
    assert.equal(rootId, 71);
    assert.equal(writes, 1);
  });
  it('should present the exact completed managed reply without resuming or selecting another composer', async () => {
    const source = await provider.getIssueComment('owner', 'repo', 3, 42);
    const selection = {
      version: 1 as const,
      requestedSkill: 'custom:reply',
      defaultSkill: false,
      observedAt: 1,
      skill: await assessmentSkillSource({
        name: 'custom:reply',
        path: join(root, 'SKILL.md'),
        scope: 'user',
      }),
    };
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        publisherLogin: 'receiver',
        events: [
          {
            id: 'b'.repeat(64),
            sourceId: source.nodeId,
            number: 3,
            nodeId: 'I_issue',
            itemType: 'issue',
            source: JSON.stringify(source),
            revision: 'c'.repeat(64),
            createdAt: 1,
            policyDigest: 'd'.repeat(64),
            phase: 'published',
            composition: selection,
            result: {
              privateText: 'The complete private explanation.',
              publicText: 'A retained public answer.',
            },
            receipt: { nodeId: 'C_confirmed', databaseId: 9 },
          },
        ],
      },
    ];
    const before = structuredClone(owners);
    const result = await call('compose', { target: `${url}#issuecomment-42` });
    assert.equal(result.status, 'managed-reply-retained');
    assert.ok(
      'presentation' in result &&
        result.presentation?.includes('The complete private explanation.'),
    );
    assert.ok('url' in result && result.url === `${url}#issuecomment-9`);
    assert.deepEqual('selection' in result && result.selection, selection);
    assert.deepEqual(owners, before);
    assert.equal(selections, 0);
    assert.equal(writes, 0);
    owners[0]!.events![0]!.phase = 'blocked';
    await assert.rejects(
      call('compose', {
        target: `${url}#issuecomment-42`,
        privateText: 'Do not bypass this owner.',
      }),
      /reply-managed-response-required/,
    );
  });
  it('should ask for missing inputs and reject incomplete sources before selecting a composer', async () => {
    assert.equal((await call('compose')).status, 'clarification-needed');
    assert.equal((await call('compose', { target: url })).status, 'clarification-needed');
    provider.getIssueComment = async () => ({
      nodeId: 'C',
      databaseId: 42,
      body: 'partial',
      bodyTruncated: true,
      createdAt: '',
      updatedAt: '',
    });
    await assert.rejects(
      call('compose', { target: `${url}#issuecomment-42`, privateText: 'Answer.' }),
      /reply-source-incomplete/,
    );
    assert.equal(selections, 0);
    assert.equal(writes, 0);
  });
  it('should retain managed issue configuration for a new explicit comment on its delivery pr', async () => {
    owners = [
      {
        id: 'b'.repeat(64),
        repository: 'owner/repo',
        number: 1,
        pullRequestNumber: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        result: {
          version: 1,
          outcome: 'plan-ready',
          summary: 'Retained plan.',
          assessment: 'Evidence.',
          plan: 'Plan.',
          evidence: [],
          progress: { completed: [], remaining: [] },
        },
      },
    ];
    provider.getItem = async () => ({
      ...intakeFixture().item,
      itemType: 'pull-request',
      pullRequest: {
        baseRef: 'main',
        headRef: 'topic',
        headSha: 'a'.repeat(40),
        baseRepositoryNodeId: 'R_repo',
        baseRepositoryDatabaseId: 10,
        draft: true,
        merged: false,
      },
    });
    deps.manifest.github = {
      notifications: {
        ...intakeFixture().policy,
        issueAssignment: {
          allowed: [],
          mode: 'plan',
          feedback: { inherit: true, allowed: [], skill: 'issue:reply' },
        },
        reviewRequest: {
          allowed: [],
          feedback: { inherit: true, allowed: [], skill: 'review:reply' },
        },
      },
    } as AgentManifest['github'];
    const result = await call('compose', {
      target: 'https://github.com/owner/repo/pull/3#issuecomment-42',
      privateText: 'Explicit new response.',
    });
    assert.ok('selection' in result && result.selection);
    assert.equal(result.selection.requestedSkill, 'issue:reply');
    assert.ok(
      'verifiedOutcome' in result &&
        result.verifiedOutcome?.assessment?.summary === 'Retained plan.',
    );
    assert.equal(owners[0]!.events, undefined);
    assert.equal(writes, 0);
  });
  it('should stop publication after native authority or the exact source changes', async () => {
    const id = await candidate(`${url}#issuecomment-42`);
    deps.assertCurrent = async () => {
      throw new Error('native-approval-denied');
    };
    await assert.rejects(call('publish', { id }), /native-approval-denied/);
    deps.assertCurrent = async () => {};
    const original = provider.getIssueComment;
    provider.getIssueComment = async (...args) => ({
      ...(await original(...args)),
      body: 'Changed question.',
    });
    await assert.rejects(call('publish', { id }), /reply-source-changed/);
    assert.equal(writes, 0);
  });
  it('should keep direct codex entry independent of intake activation and use native input and skill discovery', async () => {
    const workspace = join(root, 'workspace'),
      codexHome = join(root, 'codex'),
      pluginData = join(root, 'plugin');
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: receiver\n');
    await bindCodexWorkspace(pluginData, workspace);
    const calls: string[] = [];
    let operatorTurn = 'turn';
    let operatorInput = 'input';
    const nativeDeps = {
      codexHome,
      threadId: 'native-chat',
      replyConnection: async () => ({
        request: async (method: string) => {
          calls.push(method);
          if (method === 'thread/read') return { thread: { id: 'native-chat' } };
          if (method === 'thread/turns/list')
            return { data: [{ id: operatorTurn, status: 'inProgress' }] };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: operatorTurn,
                  item: {
                    id: operatorInput,
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Draft a reply.' }],
                  },
                },
              ],
            };
          if (method === 'skills/list')
            return {
              data: [
                {
                  cwd: workspace,
                  errors: [],
                  skills: [
                    {
                      name: 'agent-system:agent-system-github-reply',
                      path: join(root, 'SKILL.md'),
                      scope: 'user',
                      enabled: true,
                    },
                  ],
                },
              ],
            };
          throw new Error(`Unexpected native call: ${method}`);
        },
        close: async () => {},
      }),
      replyProvider: async () => provider,
    };
    const direct = (operation: string, extra: object = {}) =>
      runCodexFeedback(pluginData, { action: 'reply', operation, ...extra }, nativeDeps);
    const result = await direct('compose', { target: url, privateText: 'Direct response.' });
    assert.equal(result.status, 'composition-ready');
    assert.equal(calls.filter((x) => x === 'skills/list').length, 1);
    assert.equal(writes, 0);
    assert.ok(!(await readdir(pluginData)).some((name) => name.startsWith('github-intake-')));
    assert.ok((await readdir(pluginData)).some((name) => name.startsWith('github-reply-')));
    assert.ok((await readFile(join(root, 'SKILL.md'), 'utf8')).includes('ordinary reply'));
    assert.ok('id' in result && 'digest' in result);
    await direct('candidate', {
      id: result.id,
      digest: result.digest,
      publicText: 'Direct answer.',
    });
    const preview = await direct('publish', { id: result.id });
    assert.ok('digest' in preview);
    await direct('publish', { id: result.id, digest: preview.digest });
    await direct('reconcile', { id: result.id });
    assert.equal(writes, 1);
    assert.equal(calls.filter((x) => x === 'skills/list').length, 1);
    const update = await direct('context', { purpose: 'status-update', target: url });
    assert.ok('observation' in update && typeof update.observation === 'string');
    const status = await direct('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Native status answer.',
      update: { observation: update.observation, facts: [progressFact] },
    });
    assert.ok('id' in status && 'digest' in status);
    await direct('candidate', {
      id: status.id,
      digest: status.digest,
      publicText: 'One verified unit run passed.',
    });
    const statusPreview = await direct('publish', { id: status.id });
    assert.ok('digest' in statusPreview);
    // native later-turn verification is independent of the draft's original input receipt.
    operatorTurn = 'later-operator-turn';
    operatorInput = 'later-input';
    const statusPublished = await direct('publish', {
      id: status.id,
      digest: statusPreview.digest,
    });
    assert.equal(statusPublished.status, 'published');
    assert.equal(writes, 2);
    assert.ok(posted?.body.includes(':status-update:'));
  });
  it('should use bound openclaw user input and skills without activating a coordinator or preparing a worktree', async () => {
    const workspace = await realpath(root);
    const manifest = deps.manifest;
    const intake = new OpenClawIntake({
      root: join(root, 'intake'),
      namespace: root,
      manifestService: {
        loadForAgentId: async () => ({
          status: 'loaded' as const,
          manifest,
          scope: { agentId: 'receiver', workspaceDir: workspace },
          path: join(root, 'agent.yaml'),
          digest: 'manifest',
          diagnostics: [],
          validationChecks: [],
        }),
      },
      connect: async () => provider,
    });
    const calls: string[] = [];
    const service = new OpenClawDispatch({
      root: deps.root,
      config: () => ({}),
      intake,
      connect: async () => provider,
      worktrees: {
        prepareGitHub: async () => {
          throw new Error('unexpected worktree creation');
        },
        inspectGitHub: async () => {
          throw new Error('unexpected worktree inspection');
        },
      },
      coordinator: async () => {
        throw new Error('unexpected coordinator activation');
      },
      feedbackConnect: async () => provider,
      credential: {
        use: async (_authority, run) =>
          run(async (method) => {
            calls.push(method);
            if (method === 'chat.history')
              return {
                sessionId: 'session',
                messages: [
                  {
                    role: 'user',
                    content: 'Draft my reply.',
                    idempotencyKey: 'turn:user',
                    __openclaw: {
                      id: 'input',
                      idempotencyKey: 'turn:user',
                      runId: 'turn',
                      senderIsOwner: true,
                    },
                  },
                ],
              };
            if (method === 'skills.status')
              return {
                skills: [
                  {
                    name: 'agent-system-github-reply',
                    filePath: join(root, 'SKILL.md'),
                    source: 'user',
                    eligible: true,
                    modelVisible: true,
                  },
                ],
              };
            throw new Error(`Unexpected native method: ${method}`);
          }),
      },
    });
    const caller = {
      sessionKey: 'ordinary-chat',
      sessionId: 'session',
      runId: 'turn',
      toolCallId: 'call',
    };
    const direct = (
      operation: 'context' | 'compose' | 'candidate' | 'publish' | 'reconcile',
      extra: object = {},
    ) => service.run(manifest, workspace, caller, { action: 'reply', operation, ...extra }, true);
    await assert.rejects(
      service.run(manifest, workspace, caller, {
        action: 'reply',
        operation: 'compose',
        target: url,
        privateText: 'Answer.',
      }),
      /reply-operator-required/,
    );
    const composed = await direct('compose', { target: url, privateText: 'Answer.' });
    assert.ok('id' in composed && 'digest' in composed);
    await direct('candidate', {
      id: composed.id,
      digest: composed.digest,
      publicText: 'A concise answer.',
    });
    const preview = await direct('publish', { id: composed.id });
    assert.ok('digest' in preview);
    await direct('publish', { id: composed.id, digest: preview.digest });
    await direct('reconcile', { id: composed.id });
    assert.equal(writes, 1);
    assert.equal(calls.filter((x) => x === 'skills.status').length, 1);
    assert.ok(!(await readdir(root)).includes('intake'));
    const update = await direct('context', { purpose: 'status-update', target: url });
    assert.ok('observation' in update && typeof update.observation === 'string');
    const status = await direct('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Native status answer.',
      update: { observation: update.observation, facts: [progressFact] },
    });
    assert.ok('id' in status && 'digest' in status);
    await direct('candidate', {
      id: status.id,
      digest: status.digest,
      publicText: 'One verified unit run passed.',
    });
    const statusPreview = await direct('publish', { id: status.id });
    assert.ok('digest' in statusPreview);
    await direct('publish', { id: status.id, digest: statusPreview.digest });
    assert.equal(writes, 2);
    assert.ok(posted?.body.includes(':status-update:'));
  });
});
