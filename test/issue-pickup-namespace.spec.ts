import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import {
  pickupLimit,
  pickupMilestones,
  pickupProject,
} from '../channels/github/issue-pickup-projects.ts';
import decodeIssuePickup, { issuePickupSchema } from '../channels/github/issue-pickup-schema.ts';
import { issuePickupStateSchema } from '../agent/issue-pickup-state.ts';
import issuePickupScope from '../agent/issue-pickup-scope.ts';
import fixture from './issue-pickup-selection-fixture.ts';

describe('issue pickup namespace selections', () => {
  it('should accept bounded selectors and allowances without accepting general globs or invalid quantities', () => {
    for (const repository of ['owner/repo', 'owner/*']) {
      for (const limit of [undefined, 2, { quantity: 3 }, { quantity: 4, scope: 'repo' }]) {
        const declaration = {
          projects: [{ repository, ...(limit === undefined ? {} : { limit }) }],
        };
        assert.ok(Value.Check(issuePickupSchema, declaration));
      }
    }
    for (const repository of ['*/repo', 'owner/r*', 'owner/**', 'owner/*/repo', 'owner/repo\n'])
      assert.equal(Value.Check(issuePickupSchema, { projects: [{ repository }] }), false);
    for (const limit of [0, -1, 1.5, '2', {}, { quantity: 0 }, { quantity: 2, scope: 'owner' }])
      assert.equal(
        Value.Check(issuePickupSchema, { projects: [{ repository: 'owner/*', limit }] }),
        false,
      );
    const policy = decodeIssuePickup({ projects: [{ repository: 'owner/*' }] });
    assert.deepEqual(pickupLimit(policy.projects[0]!), { quantity: 1, scope: 'selection' });
  });

  it('should normalize equivalent milestone identifiers and retain repository-local number input', () => {
    assert.deepEqual(
      pickupMilestones({
        repository: 'tanaabased/actions',
        limit: 1,
        milestone: {
          number: 1,
          ids: [1, 'actions#1', 'tanaabased/actions#1', 'actions#2', 'tanaabased/actions#3'],
        },
      }),
      [
        { repository: 'tanaabased/actions', number: 1 },
        { repository: 'tanaabased/actions', number: 2 },
        { repository: 'tanaabased/actions', number: 3 },
      ],
    );
    assert.deepEqual(
      pickupMilestones({
        repository: 'tanaabased/*',
        limit: 1,
        milestone: { ids: ['actions#2', 'tanaabased/other#3'] },
      }),
      [
        { repository: 'tanaabased/actions', number: 2 },
        { repository: 'tanaabased/other', number: 3 },
      ],
    );
    for (const [repository, milestone] of [
      ['owner/*', { ids: 1 }],
      ['owner/*', { number: 1 }],
      ['owner/repo', { ids: 'other#1' }],
      ['owner/*', { ids: 'outside/repo#1' }],
      ['owner/repo', {}],
      ...['repo1', 'repo #1', 'repo#0', 'repo#9007199254740992', 'repo#1\n'].map((ids) => [
        'owner/repo',
        { ids },
      ]),
    ] as Array<[string, { ids?: string | number; number?: number }]>)
      assert.throws(
        () => pickupMilestones({ repository, limit: 1, milestone }),
        /milestone-invalid/,
      );
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should retain legacy exact charges and preserve the original entry after uncertain assignment in ${runtime}`, async () => {
      const legacy = fixture(runtime);
      assert.equal((await legacy.run({ selection: await legacy.select() })).status, 'assigned');
      delete legacy.state.projectPickup!.charges![0]!.selection;
      legacy.state.projectPickup!.operations = [];
      legacy.tx.runId = 'legacy-restart';
      assert.equal((await legacy.run()).status, 'allowance-reached');

      const f = fixture(runtime);
      f.policy.issuePickup!.projects = [{ repository: 'owner/*', limit: 1 }];
      const selection = await f.select();
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      assert.equal((await f.run({ selection })).status, 'attempted');
      f.state.projectPickup = JSON.parse(JSON.stringify(f.state.projectPickup));
      f.policy.issuePickup!.projects = [{ repository: 'owner/repo', limit: 1 }];
      f.tx.runId = 'recover-original-allowance';
      assert.equal((await f.run()).status, 'assigned');
      assert.equal(f.state.projectPickup!.charges![0]!.selection, 'owner/*');
      assert.equal(f.effects.writes, 1);
    });

    it(`should keep separately declared namespace allowances independent in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('other-repo');
      second.repository.owner = { ...second.repository.owner, login: 'other' };
      f.policy.routing = ['*/*'];
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 1 },
        { repository: 'other/*', limit: 1 },
      ];
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      f.tx.runId = 'other-namespace';
      const next = await f.run();
      assert.equal(next.status, 'selection-required');
      assert.ok('candidates' in next);
      assert.deepEqual(
        next.candidates.map((candidate) => candidate.repository),
        ['other/other-repo'],
      );
      assert.equal(
        (
          await f.run({
            selection: {
              issueNodeId: second.items.values().next().value!.nodeId,
              rationale: 'ready',
            },
          })
        ).status,
        'assigned',
      );
      assert.equal(f.effects.writes, 2);
    });

    it(`should charge a namespace total once across scans, restart and task completion in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.addRepository('second');
      f.policy.issuePickup!.projects = [{ repository: 'owner/*', limit: 1 }];
      const selection = await f.select();
      assert.equal((await f.run({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.ok(Value.Check(issuePickupStateSchema, f.state.projectPickup));
      f.state.projectPickup = JSON.parse(JSON.stringify(f.state.projectPickup));
      f.state.projectPickup!.operations = [];
      f.state.records = [];
      f.tx.runId = 'after-completion-and-restart';
      const exhausted = await f.run();
      assert.equal(exhausted.status, 'allowance-reached');
      assert.equal(f.effects.writes, 1);
      assert.equal(f.state.projectPickup!.charges![0]!.selection, 'owner/*');
    });

    it(`should allow separate per-repository assignments with a wildcard in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('second');
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: { quantity: 1, scope: 'repo' } },
      ];
      const selection = await f.select();
      assert.equal((await f.run({ selection })).status, 'assigned');
      f.tx.runId = 'second-repository';
      const next = await f.run();
      assert.equal(next.status, 'selection-required');
      assert.ok('candidates' in next);
      assert.deepEqual(
        next.candidates.map((candidate) => candidate.repository),
        ['owner/second'],
      );
      assert.equal(
        (
          await f.run({
            selection: {
              issueNodeId: second.items.values().next().value!.nodeId,
              rationale: 'ready work',
            },
          })
        ).status,
        'assigned',
      );
      assert.equal(f.effects.writes, 2);
    });

    for (const reverse of [false, true]) {
      it(`should replace wildcard settings with independent exact allowances regardless of order ${reverse} in ${runtime}`, async () => {
        const f = fixture(runtime);
        const second = f.addRepository('second');
        f.addRepository('third');
        const projects = [
          { repository: 'owner/*', limit: 1, filters: { labels: ['missing'] } },
          { repository: 'owner/repo', limit: 2, selection: { guidance: 'exact entry guidance' } },
        ];
        f.policy.issuePickup!.projects = reverse ? projects.reverse() : projects;
        const selection = await f.select();
        assert.equal((await f.run({ selection })).status, 'assigned');
        const policy = f.policy.issuePickup!;
        assert.equal(pickupProject(policy.projects, 'OWNER/REPO')!.limit, 2);
        delete policy.projects.find((project) => project.repository === 'owner/*')!.filters;
        f.tx.runId = 'independent-wildcard';
        const next = await f.run();
        assert.equal(next.status, 'selection-required');
        assert.ok('candidates' in next);
        assert.deepEqual(next.candidates.map((candidate) => candidate.repository).sort(), [
          'owner/second',
          'owner/third',
        ]);
        assert.equal(
          (
            await f.run({
              selection: {
                issueNodeId: second.items.values().next().value!.nodeId,
                rationale: 'ready',
              },
            })
          ).status,
          'assigned',
        );
        f.tx.runId = 'all-counted';
        // the wildcard is exhausted but the exact entry still has its unused second allowance.
        const remaining = await f.run();
        assert.equal(remaining.status, 'empty');
        assert.equal(f.effects.writes, 2);
        assert.deepEqual(
          f.state.projectPickup!.charges!.map((charge) => charge.selection),
          ['owner/repo', 'owner/*'],
        );
      });
    }

    it(`should checkpoint namespace pages, deduplicate overlaps and apply routing in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.addRepository('second');
      const denied = f.addRepository('denied');
      f.policy.routing = ['!owner/denied', 'owner/*'];
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 2 },
        { repository: 'owner/repo', limit: 1 },
      ];
      const pages: number[] = [];
      f.client.discoverPickupRepositories = async (_owner, page) => {
        pages.push(page);
        return page === 1
          ? { repositories: ['owner/repo', 'owner/second'], nextPage: 2 }
          : { repositories: ['OWNER/SECOND', 'owner/denied'] };
      };
      assert.equal((await f.run()).status, 'discovering');
      f.state.projectPickup = JSON.parse(JSON.stringify(f.state.projectPickup));
      const result = await f.run();
      assert.deepEqual(pages, [1, 2]);
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result);
      assert.deepEqual(result.candidates.map((candidate) => candidate.repository).sort(), [
        'owner/repo',
        'owner/second',
      ]);
      assert.equal(denied.items.values().next().value!.assignees.length, 0);
    });

    it(`should resolve the milestone union across repositories and fail closed on an unavailable reference in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('second');
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 1, milestone: { ids: ['repo#10', 'owner/second#10'] } },
      ];
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result);
      assert.equal(result.candidates.length, 2);
      assert.ok(result.candidates.every((candidate) => candidate.pickupScope === 'only'));
      f.tx.runId = 'unavailable';
      f.client.getMilestone = async (_owner, name) => {
        if (name === 'second') throw new Error('issue-pickup-milestone-unavailable');
        return f.milestone;
      };
      f.policy.issuePickup!.projects[0]!.milestone!.policy = 'prefer';
      assert.equal((await f.run()).status, 'failed');
      assert.equal(f.effects.writes, 0);
      assert.equal(second.items.values().next().value!.assignees.length, 0);
    });

    it(`should prohibit entry-wide fallback after a preferred candidate read failure in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('second');
      for (const item of second.items.values())
        if (item.itemType === 'issue') item.milestone = null;
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 1, milestone: { ids: 'repo#10', policy: 'prefer' } },
      ];
      const read = f.client.projectCandidate;
      f.client.projectCandidate = async (owner, name, number) => {
        if (name === 'repo') throw new Error('issue-pickup-candidate-invalid');
        return read(owner, name, number);
      };
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('fallbackUnavailable' in result);
      assert.deepEqual(result.fallbackUnavailable, ['owner/second']);
      const selected = await f.run({
        selection: {
          issueNodeId: second.items.values().next().value!.nodeId,
          rationale: 'fallback',
          fallback: { repository: 'owner/second', reason: 'none suitable' },
        },
      });
      assert.equal(selected.status, 'failed');
      assert.equal(f.effects.writes, 0);
    });

    it(`should expose one preferred group and allow explained fallback elsewhere in that namespace in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('second');
      for (const item of second.items.values())
        if (item.itemType === 'issue') item.milestone = null;
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 1, milestone: { ids: 'repo#10', policy: 'prefer' } },
      ];
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result);
      assert.deepEqual(
        result.candidates.map(({ selectionScope, pickupScope }) => ({
          selectionScope,
          pickupScope,
        })),
        [
          { selectionScope: 'owner/*', pickupScope: 'preferred' },
          { selectionScope: 'owner/*', pickupScope: 'fallback' },
        ],
      );
      assert.equal(
        (
          await f.run({
            selection: {
              issueNodeId: second.items.values().next().value!.nodeId,
              rationale: 'preferred work needs clarification',
              fallback: {
                repository: 'owner/second',
                reason: 'the preferred milestone work is not actionable',
              },
            },
          })
        ).status,
        'assigned',
      );
      assert.equal(f.effects.writes, 1);
    });

    it(`should keep local numeric scope behavior while namespace only excludes unlisted repositories in ${runtime}`, async () => {
      const f = fixture(runtime);
      const second = f.addRepository('second');
      f.policy.issuePickup!.projects = [
        { repository: 'owner/*', limit: 1, milestone: { ids: 'repo#10' } },
      ];
      const scope = await issuePickupScope(f.policy, f.client, second.repository);
      assert.deepEqual(scope, { policy: 'only', milestoneNodeIds: [] });
      const selection = await f.select();
      assert.equal((await f.run({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });
  }
});
