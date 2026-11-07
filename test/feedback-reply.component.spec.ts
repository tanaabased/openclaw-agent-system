import { feedbackRevision } from '../agent/feedback-source.ts';
import replyOwnPublications from '../agent/reply-own-publications.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assessmentSkillSource from '../agent/assessment-skill-source.ts';
import feedbackReply, { type FeedbackReplyDependencies } from '../agent/feedback-reply.ts';
import type { OpenClawFeedbackProvider } from '../agent/openclaw-feedback.ts';
import replyOwner, { type ReplyOwner } from '../agent/reply-owner.ts';
import ReplyStore from '../agent/reply-store.ts';
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

import hydrateImplementation from './implementation-material-fixture.ts';
import nativeMaterialFixture from './native-material-fixture.ts';
const url = 'https://github.com/owner/repo/issues/3';
describe('agent/feedback-reply', () => {
  let root: string, deps: FeedbackReplyDependencies, provider: OpenClawFeedbackProvider;
  let selections: number, writes: number, lost: boolean, hidden: boolean;
  let postedNumber: number | undefined;
  let posted: { nodeId: string; databaseId: number; body: string } | undefined;
  let owners: ReplyOwner[];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'direct-reply-')));
    await writeFile(join(root, 'SKILL.md'), '# ordinary reply composer');
    selections = writes = 0;
    lost = hidden = false;
    posted = undefined;
    postedNumber = undefined;
    owners = [];
    const fixture = intakeFixture();
    provider = {
      ...fixture.client,
      getItemContext: async () => {
        throw new Error('reply publication must not load planning context');
      },
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
      createIssueComment: async (_o, _n, number, body) => {
        writes++;
        postedNumber = number;
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
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should compose a status update from the returned request in ${runtime}`, async () => {
      deps.binding.runtime = runtime;
      const context = await call('context', { purpose: 'status-update', target: url });
      assert.ok('composeRequest' in context && context.composeRequest);
      const request = context.composeRequest;
      assert.equal(request.target, url);
      assert.equal(request.update.observation, context.observation);
      assert.equal((await feedbackReply(request, deps)).status, 'already-current');
      const compose = {
        ...request,
        privateText: 'Verified progress with caveats.',
        update: { ...request.update, facts: [progressFact] },
      };
      await assert.rejects(
        feedbackReply({ ...compose, observation: context.observation }, deps),
        /reply-request-invalid/,
      );
      await assert.rejects(
        feedbackReply(
          { ...compose, update: { ...compose.update, observation: '0'.repeat(64) } },
          deps,
        ),
        /status-update-observation-changed/,
      );
      assert.deepEqual(await new ReplyStore(deps.root, deps.binding).read(), []);
      const result = await feedbackReply(compose, deps);
      assert.equal(result.status, 'composition-ready');
      assert.ok('source' in result && result.source && 'facts' in result.source);
      assert.deepEqual(result.source.facts, [progressFact]);
      assert.equal(writes, 0);
    });

    it(`should deliver a complete reply source in ${runtime} without recreating or publishing a draft`, async () => {
      deps.binding.runtime = runtime;
      const privateText = 'Verified progress: preserve the complete response.\n'.repeat(250);
      const request = { action: 'reply', operation: 'compose', target: url, privateText };
      const run = (read: Record<string, unknown>) => feedbackReply(read, deps);
      const verify = (complete: Record<string, unknown>) =>
        assert.equal(complete.privateResponse, privateText);
      if (runtime === 'openclaw') await nativeMaterialFixture({ request, run, verify });
      else verify(await hydrateImplementation(await run(request), run));
      const drafts = await new ReplyStore(deps.root, deps.binding).read();
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]!.privateText, privateText);
      assert.equal(drafts[0]!.publicText, undefined);
      const composed = await call('compose', { id: drafts[0]!.id });
      assert.ok('contextMaterials' in composed && composed.contextMaterials);
      assert.ok('id' in composed && 'digest' in composed);
      const page = composed.contextMaterials.fields[0]!.request;
      await assert.rejects(run({ ...page, operation: 'publish' }), /reply-request-invalid/);
      await assert.rejects(run({ ...page, digest: '0'.repeat(64) }), /reply-material-stale/);
      await call('candidate', {
        id: composed.id,
        digest: composed.digest,
        publicText: 'Verified progress.',
      });
      const saved = await new ReplyStore(deps.root, deps.binding).read();
      await assert.rejects(run(page), /reply-material-stale/);
      assert.deepEqual(await new ReplyStore(deps.root, deps.binding).read(), saved);
      assert.equal(writes, 0);
    });

    it(`should deliver status discussion references in ${runtime} without prefetching comments`, async () => {
      deps.binding.runtime = runtime;
      provider.listIssueComments = async () => {
        throw new Error('unexpected discussion prefetch');
      };
      const request = {
        action: 'reply',
        operation: 'context',
        purpose: 'status-update',
        target: url,
      };
      const run = (read: Record<string, unknown>) => feedbackReply(read, deps);
      const verify = (complete: Record<string, unknown>) => {
        assert.deepEqual((complete.publicContext as { discussion: unknown }).discussion, {
          source: url,
        });
        assert.equal('contextMaterials' in complete, false);
      };
      if (runtime === 'openclaw')
        await nativeMaterialFixture({ request, run, verify, minimumPages: 0 });
      else verify(await run(request));
      assert.deepEqual(await new ReplyStore(deps.root, deps.binding).read(), []);
      assert.equal(writes, 0);
    });
  }

  async function candidate(target = url) {
    const composed = await call('compose', {
      target,
      privateText: 'Detailed supplied response.',
      outcome: 'No checks were run.',
    });
    assert.equal(composed.status, 'composition-ready');
    assert.ok('id' in composed && typeof composed.id === 'string' && 'digest' in composed);
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
  it('should preserve legacy drafts while writing each new operation independently', async () => {
    const first = await candidate();
    const store = new ReplyStore(deps.root, deps.binding);
    const drafts = await store.read();
    const firstPath = join(deps.root, `github-reply-${store.scope}-${first}.json`);
    await writeFile(store.path, JSON.stringify({ scope: store.scope, drafts }), { mode: 0o600 });
    await rm(firstPath);
    deps.inputId = 'later-input';
    const second = await candidate(`${url}#issuecomment-5`);
    assert.notEqual(second, first);
    assert.equal((await store.read()).length, 2);
    const oldContents = await readFile(store.path, 'utf8');
    const digest = await preview(first);
    await call('publish', { id: first, digest });
    const readback = await new ReplyStore(deps.root, deps.binding).read();
    assert.ok(readback.find((draft) => draft.id === first)?.receipt);
    assert.ok(readback.find((draft) => draft.id === second));
    assert.equal(await readFile(store.path, 'utf8'), oldContents);
  });

  it('should reconcile a sent reply after its source comment disappears', async () => {
    const id = await candidate(`${url}#issuecomment-4`);
    const digest = await preview(id);
    lost = hidden = true;
    await assert.rejects(call('publish', { id, digest }), /transport lost/);
    provider.getIssueComment = async () => {
      throw new Error('source deleted');
    };
    hidden = false;
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal(writes, 1);
  });

  const progressFact = {
    key: 'unit-check',
    reference: 'commit:abc',
    revision: 'abc:unit-run-1',
    text: 'The unit checks passed.',
  };
  async function updateContext(target = url) {
    const result = await call('context', { purpose: 'status-update', target });
    assert.ok('observation' in result && typeof result.observation === 'string');
    return result.observation;
  }
  async function updateCandidate(target = url) {
    const result = await call('compose', {
      purpose: 'status-update',
      target,
      privateText: 'Complete private answer.\nPreserve the caveats.',
      update: { observation: await updateContext(target), facts: [progressFact] },
    });
    assert.ok('id' in result && 'digest' in result && 'source' in result);
    assert.ok('kind' in result.source && result.source.kind === 'status-update');
    assert.ok('facts' in result.source);
    assert.deepEqual(result.source.facts, [progressFact]);
    assert.equal(result.source.destination, target.split('#')[0]);
    await call('candidate', {
      id: result.id,
      digest: result.digest,
      publicText: 'Unit checks passed.\n\nNo installed checks ran.',
    });
    return result.id!;
  }
  function linkedPullRequest() {
    const pr = {
      ...intakeFixture().item,
      nodeId: 'PR_4',
      number: 4,
      itemType: 'pull-request' as const,
      pullRequest: {
        baseRef: 'main',
        headRef: 'topic',
        headSha: 'a'.repeat(40),
        baseRepositoryNodeId: 'R_repo',
        baseRepositoryDatabaseId: 10,
        draft: true,
        merged: false,
      },
    };
    const prUrl = 'https://github.com/owner/repo/pull/4';
    const originalItem = provider.getItem;
    provider.getItem = async (owner, name, number) =>
      number === 4 ? pr : originalItem(owner, name, number);
    return { item: pr, url: prUrl };
  }
  it('should start with the issue and select only an open linked pr for the default update destination', async () => {
    const read = () => call('context', { purpose: 'status-update', target: url });
    const noLink = await read();
    assert.ok('defaultDestination' in noLink && noLink.defaultDestination === url);
    const pr = linkedPullRequest();
    const mentioned = await read();
    assert.ok('defaultDestination' in mentioned && mentioned.defaultDestination === url);
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 4,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
      },
    ];
    const linked = await read();
    assert.ok('defaultDestination' in linked && linked.defaultDestination === pr.url);
    assert.equal(linked.destination, url);
    for (const merged of [false, true]) {
      pr.item.state = 'closed';
      pr.item.pullRequest.merged = merged;
      const closed = await read();
      assert.ok('defaultDestination' in closed && closed.defaultDestination === url);
    }
    assert.equal(writes, 0);
  });
  it('should ignore pr mentions while reading the actual retained link', async () => {
    const pr = linkedPullRequest();
    const originalItem = provider.getItem;
    provider.getItem = async (owner, name, number) => {
      if (number === 3) return originalItem(owner, name, number);
      if (number === 7) return { ...pr.item, number, nodeId: `PR_${number}` };
      throw new Error('unrelated pr unavailable');
    };
    provider.listIssueComments = async (_owner, _name, number) => {
      assert.equal(number, 3);
      return {
        comments: [
          {
            ...(await provider.getIssueComment('owner', 'repo', 3, 9)),
            body: [4, 5, 6]
              .map((value) => `https://github.com/owner/repo/pull/${value}`)
              .join('\n'),
          },
        ],
        truncated: false,
      };
    };
    const read = () => call('context', { purpose: 'status-update', target: url });
    const multiple = await read();
    assert.ok('defaultDestination' in multiple && multiple.defaultDestination === url);
    assert.ok('publicContext' in multiple && multiple.publicContext);
    assert.deepEqual(multiple.publicContext.pullRequests, []);
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 7,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
      },
    ];
    const retained = await read();
    assert.ok(
      'defaultDestination' in retained &&
        retained.defaultDestination === 'https://github.com/owner/repo/pull/7',
    );
    assert.ok('publicContext' in retained && retained.publicContext);
    assert.deepEqual(
      retained.publicContext.pullRequests.map(({ item }) => item.number),
      [7],
    );
    assert.equal(writes, 0);
  });
  it('should publish at the selected pr or explicit issue without rerouting either write', async () => {
    const pr = linkedPullRequest();
    const prId = await updateCandidate(pr.url);
    const prResult = await call('publish', { id: prId, digest: await preview(prId) });
    assert.ok('url' in prResult && prResult.url === `${pr.url}#issuecomment-9`);
    assert.equal(postedNumber, 4);
    const issueId = await updateCandidate(url);
    await call('publish', { id: issueId, digest: await preview(issueId) });
    assert.equal(postedNumber, 3);
    assert.equal(writes, 2);
  });
  it('should publish current progress with discussion links without loading planning context', async () => {
    const pr = linkedPullRequest();
    provider.listIssueComments = async () => {
      throw new Error('unexpected discussion prefetch');
    };
    for (const target of [url, pr.url]) {
      const context = await call('context', { purpose: 'status-update', target });
      assert.ok('publicContext' in context && context.publicContext);
      assert.deepEqual(context.publicContext.discussion, { source: target });
      const id = await updateCandidate(target);
      assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'published');
    }
    assert.equal(writes, 2);
  });
  it('should reconcile an uncertain pr update at its original destination after the pr closes', async () => {
    const pr = linkedPullRequest();
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 4,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
      },
    ];
    const id = await updateCandidate(pr.url);
    lost = true;
    assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'uncertain');
    pr.item.state = 'closed';
    pr.item.pullRequest.merged = true;
    const issueContext = await call('context', { purpose: 'status-update', target: url });
    assert.equal(issueContext.status, 'status-update-context');
    assert.ok('pendingUpdates' in issueContext);
    assert.deepEqual(issueContext.pendingUpdates, [{ id, destination: pr.url }]);
    const recovered = await call('reconcile', { id });
    assert.ok('url' in recovered && recovered.url === `${pr.url}#issuecomment-9`);
    assert.equal(postedNumber, 4);
    assert.equal(writes, 1);
  });
  it('should compose a fresh pr comment instead of returning the original delivery card', async () => {
    const pr = linkedPullRequest();
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 4,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        ...{ delivery: { announcement: { receipt: { nodeId: 'existing' } } } },
      },
    ];
    deps.manifest.github = {
      notifications: {
        ...intakeFixture().policy,
        issueAssignment: {
          allowed: [],
          mode: 'plan',
          feedback: {
            inherit: true,
            allowed: [],
            skill: 'agent:voice-reply',
            guidance: 'Keep the agent voice.',
          },
        },
        reviewRequest: {
          allowed: [],
          feedback: {
            inherit: true,
            allowed: [],
            skill: 'other:reply',
          },
        },
      },
    } as AgentManifest['github'];
    const before = structuredClone(owners);
    const update = await call('compose', {
      purpose: 'status-update',
      target: pr.url,
      privateText: 'Verified progress.',
      update: { observation: await updateContext(pr.url), facts: [progressFact] },
    });
    assert.ok('selection' in update && update.selection);
    assert.equal(update.selection.requestedSkill, 'agent:voice-reply');
    assert.equal(update.selection.guidance?.content, 'Keep the agent voice.');
    const id = await candidate(pr.url);
    assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'published');
    assert.equal(postedNumber, 4);
    assert.deepEqual(owners, before);
  });
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
    assert.equal(again.status, 'already-current');
    await call('reconcile', { id });
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should keep completed and uncertain receipts usable after more than forty distinct drafts', async () => {
    const completed = await updateCandidate();
    await call('publish', { id: completed, digest: await preview(completed) });
    const completedComment = posted;
    for (let index = 0; index < 40; index++) {
      const next = await call('compose', {
        target: url,
        privateText: `Distinct progress ${index}.`,
      });
      assert.equal(next.status, 'composition-ready');
    }
    const uncertain = await candidate();
    assert.equal(typeof uncertain, 'string');
    lost = true;
    await assert.rejects(
      call('publish', { id: uncertain, digest: await preview(uncertain) }),
      /transport lost/,
    );
    assert.equal((await call('reconcile', { id: uncertain })).status, 'published');
    posted = completedComment;
    assert.equal((await call('reconcile', { id: completed })).status, 'published');
    assert.equal(writes, 2);
  });
  it('should expose an uncertain update independently and reconcile without another composer or create', async () => {
    const id = await updateCandidate();
    const digest = await preview(id);
    lost = true;
    const lostResult = await call('publish', { id, digest });
    assert.equal(lostResult.status, 'uncertain');
    hidden = true;
    const pending = await call('context', { purpose: 'status-update', target: url });
    assert.equal(pending.status, 'status-update-context');
    assert.ok('pendingUpdates' in pending);
    assert.deepEqual(pending.pendingUpdates, [{ id, destination: url }]);
    const uncertain = await call('reconcile', { id });
    assert.equal(uncertain.status, 'uncertain');
    assert.ok('presentation' in uncertain && !uncertain.presentation?.includes('#issuecomment-9'));
    hidden = false;
    await call('reconcile', { id });
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should permit new material facts while preserving an uncertain earlier update', async () => {
    const id = await updateCandidate();
    lost = true;
    await call('publish', { id, digest: await preview(id) });
    const firstComment = posted;
    const overlapping = await call('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'Same evidence.',
      update: { observation: await updateContext(), facts: [progressFact] },
    });
    assert.equal(overlapping.status, 'reply-reconciliation-required');
    assert.ok('id' in overlapping && overlapping.id === id);
    const next = await call('compose', {
      purpose: 'status-update',
      target: url,
      privateText: 'The revised plan is ready.',
      update: {
        observation: await updateContext(),
        facts: [
          {
            key: 'plan',
            reference: 'chat:decision',
            revision: '2',
            text: 'The revised plan removes the extra step.',
          },
        ],
      },
    });
    assert.ok('id' in next && 'digest' in next && next.status === 'composition-ready');
    await call('candidate', {
      id: next.id,
      digest: next.digest,
      publicText: 'The revised plan removes the extra step.',
    });
    lost = false;
    assert.equal(
      (await call('publish', { id: next.id, digest: await preview(next.id!) })).status,
      'published',
    );
    posted = firstComment;
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal(writes, 2);
  });
  it('should coalesce published facts and preserve an issue attempt after the linked pr opens', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
      },
    ];
    const id = await updateCandidate();
    lost = true;
    await call('publish', { id, digest: await preview(id) });
    const pr = linkedPullRequest();
    owners[0]!.pullRequestNumber = 4;
    const overlap = await call('compose', {
      purpose: 'status-update',
      target: pr.url,
      privateText: 'Reworded progress.',
      update: { observation: await updateContext(pr.url), facts: [progressFact] },
    });
    assert.equal(overlap.status, 'reply-reconciliation-required');
    assert.ok('destination' in overlap && overlap.destination === url);
    await call('reconcile', { id });
    const fresh = {
      key: 'delivery',
      reference: 'commit:def',
      revision: 'def',
      text: 'The follow-up fix is delivered.',
    };
    const next = await call('compose', {
      purpose: 'status-update',
      target: pr.url,
      privateText: 'Checks and follow-up delivery.',
      update: { observation: await updateContext(pr.url), facts: [progressFact, fresh] },
    });
    assert.ok('source' in next && 'facts' in next.source);
    assert.deepEqual(next.source.facts, [fresh]);
    assert.equal(writes, 1);
  });
  it('should leave discussion comparison to native reads without blocking an authorized update', async () => {
    const id = await updateCandidate();
    const digest = await preview(id);
    provider.listIssueComments = async () => {
      throw new Error('discussion belongs to native reads');
    };
    assert.equal((await call('publish', { id, digest })).status, 'published');
    assert.equal(writes, 1);
  });
  it('should refresh a changed pr snapshot while retaining the unattempted fact identity', async () => {
    const pr = linkedPullRequest();
    const id = await updateCandidate(pr.url);
    const digest = await preview(id);
    pr.item.pullRequest.headSha = 'b'.repeat(40);
    const stale = await call('publish', { id, digest });
    assert.equal(stale.status, 'blocked');
    assert.ok('code' in stale && stale.code === 'status-update-observation-changed');
    assert.equal(await updateCandidate(pr.url), id);
    await assert.rejects(call('publish', { id, digest }), /reply-publication-stale/);
    assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'published');
    assert.equal(writes, 1);
    assert.equal(selections, 2);
  });
  it('should keep task history out of drafts and reconcile an older attempt after history grows', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        events: Array.from({ length: 9 }, (_, index) => ({
          id: index.toString(16).padStart(64, '0'),
          sourceId: `C_${index}`,
          number: 3,
          nodeId: 'I_issue',
          itemType: 'issue' as const,
          source: '{}',
          revision: 'b'.repeat(64),
          createdAt: index,
          policyDigest: 'c'.repeat(64),
          phase: 'responded' as const,
          result: { privateText: 'retained history '.repeat(1800) },
        })),
      },
    ];
    const id = await updateCandidate();
    const store = new ReplyStore(deps.root, deps.binding);
    const stored = () => store.exclusive(async (drafts) => structuredClone(drafts[0]!));
    assert.deepEqual(JSON.parse((await stored()).ownerContext), {
      ownerId: owners[0]!.id,
      workflow: 'issue-assignment',
    });
    await store.exclusive(async (drafts, save) => {
      drafts[0]!.ownerContext = JSON.stringify({
        status: 'status-update-context',
        ownerId: owners[0]!.id,
        workflow: 'issue-assignment',
        verifiedOutcome: { feedback: [] },
      });
      drafts[0]!.update!.observation = 'f'.repeat(64);
      await save();
    });
    assert.equal(await updateCandidate(), id);
    lost = true;
    assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'uncertain');
    await store.exclusive(async (drafts, save) => {
      drafts[0]!.ownerContext = JSON.stringify({
        status: 'status-update-context',
        ownerId: owners[0]!.id,
        workflow: 'issue-assignment',
        verifiedOutcome: { feedback: [] },
      });
      await save();
    });
    const attempted = await stored();
    owners[0]!.events!.push({ ...owners[0]!.events![0]!, id: 'd'.repeat(64) });
    const pending = await call('context', { purpose: 'status-update', target: url });
    assert.equal(pending.status, 'status-update-context');
    assert.ok(
      'pendingUpdates' in pending && pending.pendingUpdates?.some((entry) => entry.id === id),
    );
    const refused = await call('compose', {
      id,
      purpose: 'status-update',
      privateText: 'Replacement text.',
      update: { observation: 'e'.repeat(64), facts: [{ ...progressFact, text: 'Reworded.' }] },
    });
    assert.equal(refused.status, 'reply-reconciliation-required');
    assert.deepEqual(await stored(), attempted);
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal((await stored()).ownerContext, attempted.ownerContext);
    assert.equal((await stored()).publicText, attempted.publicText);
    assert.equal(writes, 1);
  });
  it('should reject invalid fact identities without fetching discussion', async () => {
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
    provider.listIssueComments = async () => {
      throw new Error('provider unavailable');
    };
    assert.equal(typeof (await updateContext()), 'string');
    assert.equal(selections, 0);
    assert.equal(writes, 0);
  });
  it('should keep status updates independent of pending summaries and announcements', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        ...{
          summary: { attempt: 'uncertain-summary' },
          delivery: { announcement: { attempted: true } },
        },
      },
    ];
    const before = structuredClone(owners);
    const context = await call('context', { purpose: 'status-update', target: url });
    assert.ok('entry' in context && context.entry === 'managed');
    assert.equal(selections, 0);
    await updateCandidate();
    assert.equal(selections, 1);
    assert.deepEqual(owners, before);
    owners[0]!.inactive = true;
    await assert.rejects(updateContext(), /reply-managed-context-invalid/);
    assert.equal(writes, 0);
  });
  it('should include verified linked pr facts and withhold a candidate after the linked head changes', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 4,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
      },
    ];
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
    assert.equal(await updateCandidate(), id);
    assert.equal((await call('publish', { id, digest: await preview(id) })).status, 'published');
    assert.equal(writes, 1);
  });
  async function nativeFeedback(number = 42) {
    const source = await provider.getIssueComment('owner', 'repo', 3, number);
    const revision = feedbackRevision(source);
    deps.feedback = {
      ownerId: 'a'.repeat(64),
      eventId: String(number).padStart(64, 'b'),
      revision,
      source: JSON.stringify(source),
      number: 3,
      nodeId: 'I_issue',
      itemType: 'issue',
    };
    deps.authorizeFeedback = async (reference, target) => {
      assert.equal(reference.eventId, deps.feedback!.eventId);
      if (target.source?.nodeId !== source.nodeId || target.revision !== revision)
        throw new Error('feedback-source-changed');
    };
    return url + '#issuecomment-' + number;
  }
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should reply once to verified choices despite blocked implementation in ${runtime}`, async () => {
      deps.binding.runtime = runtime;
      deps.manifest.debug = true;
      const target = await nativeFeedback();
      owners = [
        {
          id: deps.feedback!.ownerId,
          threadId: 'chat',
          incarnation: 'session',
          inactive: false,
          repository: 'owner/repo',
          number: 3,
          result: { outcome: 'blocked', summary: 'continuation-turn-state-unresolved' } as never,
        },
      ];
      const before = structuredClone(owners);
      const privateText =
        'Both choices are known. Native continuation failed before any poem was written.';
      const composed = await call('compose', { target, privateText });
      assert.ok('id' in composed && 'digest' in composed);
      assert.ok(typeof composed.id === 'string');
      await call('candidate', {
        id: composed.id,
        digest: composed.digest,
        publicText:
          'Haiku about overengineering confirmed. A continuation error currently prevents writing it.',
      });
      const done = await call('publish', { id: composed.id, digest: await preview(composed.id) });
      assert.equal(done.status, 'published');
      assert.ok('presentation' in done && typeof done.presentation === 'string');
      assert.ok(done.presentation.startsWith('> A question.'));
      assert.ok(
        done.presentation.includes(
          '[Comment ↗](' + target + ') from [@author](https://github.com/author)',
        ),
      );
      assert.ok(done.presentation.includes(privateText));
      assert.ok(
        done.presentation.includes('> @author\n>\n> Haiku about overengineering confirmed.'),
      );
      assert.ok(done.presentation.includes('[Reply ↗](' + url + '#issuecomment-9)'));
      assert.ok(done.presentation.includes('Feedback reply instructions'));
      assert.ok(!posted!.body.includes(privateText));
      assert.ok(!posted!.body.includes('Debug'));
      deps.manifest.debug = false;
      const recovered = await call('reconcile', { id: composed.id });
      assert.equal(recovered.status, 'published');
      assert.ok('presentation' in recovered && typeof recovered.presentation === 'string');
      assert.ok(!recovered.presentation.includes('Debug'));
      assert.equal(writes, 1);
      assert.deepEqual(owners, before);
    });
  it('should keep a native reply independent of evolving issue outcomes without progress comparison', async () => {
    const target = await nativeFeedback();
    owners = [
      {
        id: deps.feedback!.ownerId,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        repository: 'owner/repo',
        number: 3,
        result: { outcome: 'plan-ready', summary: 'Old plan.' } as never,
      },
    ];
    const id = await candidate(target);
    owners[0]!.result = { outcome: 'clarification-needed', summary: 'Changed plan.' } as never;
    const digest = await preview(id);
    assert.equal((await call('publish', { id, digest })).status, 'published');
    const repeated = await call('compose', {
      target,
      privateText: 'Different wording for the same source.',
    });
    assert.equal(repeated.status, 'reply-reconciliation-required');
    assert.equal('id' in repeated && repeated.id, id);
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  it('should recheck native source authority before writing while keeping uncertain reply recovery independent', async () => {
    const target = await nativeFeedback();
    const id = await candidate(target);
    const digest = await preview(id);
    const authorize = deps.authorizeFeedback!;
    deps.authorizeFeedback = async () => {
      throw new Error('feedback-not-approved');
    };
    await assert.rejects(call('publish', { id, digest }), /feedback-not-approved/);
    assert.equal(writes, 0);
    deps.authorizeFeedback = authorize;
    lost = hidden = true;
    await assert.rejects(call('publish', { id, digest }));
    deps.authorizeFeedback = async () => {
      throw new Error('feedback-not-approved');
    };
    hidden = false;
    assert.equal((await call('reconcile', { id })).status, 'published');
    assert.equal(writes, 1);
  });
  it('should identify an uncertain native reply during discovery without posting or repeating work', async () => {
    const id = await candidate(await nativeFeedback());
    const digest = await preview(id);
    lost = hidden = true;
    await assert.rejects(call('publish', { id, digest }));
    hidden = false;
    assert.deepEqual(
      await replyOwnPublications({
        root: deps.root,
        binding: deps.binding,
        client: provider,
        replies: provider.replies,
      }),
      ['C_published'],
    );
    assert.equal(writes, 1);
    assert.equal(selections, 1);
  });
  for (const facts of [[progressFact], []])
    it(`should answer a native status question with ${facts.length} new facts at its original source`, async () => {
      const target = await nativeFeedback();
      linkedPullRequest();
      owners = [
        {
          id: deps.feedback!.ownerId,
          repository: 'owner/repo',
          number: 3,
          pullRequestNumber: 4,
          threadId: 'chat',
          incarnation: 'session',
          inactive: false,
        },
      ];
      const read = await call('context', { purpose: 'status-update', target });
      assert.ok('observation' in read);
      assert.equal('defaultDestination' in read && read.defaultDestination, target);
      const composed = await call('compose', {
        purpose: 'status-update',
        target,
        privateText: 'The checks passed; no further progress.',
        update: { observation: read.observation, facts },
      });
      assert.equal(composed.status, 'composition-ready');
      assert.ok('id' in composed && 'digest' in composed && 'source' in composed);
      assert.equal('request' in composed.source && composed.source.request?.databaseId, 42);
      await call('candidate', {
        id: composed.id,
        digest: composed.digest,
        publicText: 'The checks passed; no further progress.',
      });
      const digest = await preview(composed.id!);
      lost = hidden = true;
      assert.equal((await call('publish', { id: composed.id, digest })).status, 'uncertain');
      hidden = false;
      assert.equal((await call('reconcile', { id: composed.id })).status, 'published');
      assert.equal(postedNumber, 3);
      assert.ok(posted?.body.includes('@author'));
      assert.equal(
        (await call('compose', { target, privateText: 'Reply again.' })).status,
        'reply-reconciliation-required',
      );
      const repeated = await call('compose', {
        purpose: 'status-update',
        target,
        privateText: 'New wording.',
        update: { observation: 'f'.repeat(64), facts: [{ ...progressFact, revision: 'new' }] },
      });
      assert.equal(repeated.status, 'reply-reconciliation-required');
      assert.equal('id' in repeated && repeated.id, composed.id);
      assert.equal(writes, 1);
      assert.equal(selections, 1);
    });
  it('should allow the same progress facts to answer separate native questions', async () => {
    const target = await nativeFeedback();
    const id = await updateCandidate(target);
    await call('publish', { id, digest: await preview(id) });
    const next = await updateCandidate(await nativeFeedback(43));
    assert.notEqual(next, id);
    await call('publish', { id: next, digest: await preview(next) });
    assert.equal(writes, 2);
  });
  it('should keep native self feedback private for replies and status updates', async () => {
    const target = await nativeFeedback();
    const original = provider.getIssueComment;
    provider.getIssueComment = async (...args) => ({
      ...(await original(...args)),
      author: provider.identity,
    });
    await assert.rejects(
      call('compose', { target, privateText: 'Self answer.' }),
      /feedback-self-publication-denied/,
    );
    await assert.rejects(
      call('context', { target, purpose: 'status-update' }),
      /feedback-self-publication-denied/,
    );
    assert.equal(writes, 0);
    assert.equal(selections, 0);
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
    assert.ok('verifiedOutcome' in composed && !('assessment' in composed.verifiedOutcome));
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
        const target = workflow === 'issueAssignment' ? url : url.replace('/issues/', '/pull/');
        const result = await call('compose', {
          target,
          privateText: JSON.stringify(configuration),
          purpose: 'status-update',
          update: {
            observation: await updateContext(target),
            facts: [{ ...progressFact, key: JSON.stringify(configuration) }],
          },
        });
        assert.ok('selection' in result && result.selection);
        assert.equal(
          result.selection.requestedSkill,
          configuration.skill ?? 'agent-system:agent-system-github-reply',
        );
        if (configuration.guidance && typeof configuration.guidance !== 'string') {
          assert.equal(result.selection.guidance?.content, undefined);
          assert.equal(
            await readFile(result.selection.guidance!.path!, 'utf8'),
            'Preserve caveats.\nExplain the outcome.',
          );
        } else assert.equal(result.selection.guidance?.content, configuration.guidance);
      }
    }
    assert.equal(selections, 12);
  });
  it('should compose new requested comments independently of prior summaries and reject invalid or foreign owners', async () => {
    owners = [
      {
        id: 'a'.repeat(64),
        repository: 'owner/repo',
        number: 3,
        threadId: 'chat',
        incarnation: 'session',
        inactive: false,
        ...{ summary: { receipt: { nodeId: 'existing' } } },
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
    const before = structuredClone(owners);
    await candidate();
    assert.deepEqual(owners, before);
    assert.equal(selections, 1);
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
    assert.ok('verifiedOutcome' in result && result.verifiedOutcome);
    assert.equal('assessment' in result.verifiedOutcome, false);
    assert.doesNotMatch(JSON.stringify(result), /Retained plan\./);
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
    const pr = linkedPullRequest();
    const update = await direct('context', { purpose: 'status-update', target: pr.url });
    assert.ok('observation' in update && typeof update.observation === 'string');
    const status = await direct('compose', {
      purpose: 'status-update',
      target: pr.url,
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
    assert.equal(postedNumber, 4);
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
    assert.ok('id' in composed && typeof composed.id === 'string' && 'digest' in composed);
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
    const pr = linkedPullRequest();
    const update = await direct('context', { purpose: 'status-update', target: pr.url });
    assert.ok('observation' in update && typeof update.observation === 'string');
    const status = await direct('compose', {
      purpose: 'status-update',
      target: pr.url,
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
    assert.equal(postedNumber, 4);
    assert.ok(posted?.body.includes(':status-update:'));
  });
});
