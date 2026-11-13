import composeResponseBlocks from '../channels/github/presentation/response-blocks.ts';
import assert from 'node:assert/strict';

import {
  assessmentGitContext,
  type AssessmentGitRecord,
} from '../agent/tasks/assessment/assessment-git-context.ts';
import { renderBoundAssessment } from '../agent/tasks/assessment/assessment-render.ts';
import type { ManagedIssue } from '../agent/tasks/managed-issue.ts';

const commit = 'abc1234' + '1'.repeat(33);
const issue = {
  repository: { owner: { login: 'owner' }, name: 'repo' },
  issue: { number: 3 },
} as ManagedIssue;

describe('agent/assessment-git-context', () => {
  it('should retain an original named checkout independently of delivery and optional read failures', async () => {
    const record = {
      project: { commit, ref: 'refs/tags/v1.0.0' },
      delivery: { binding: { head: '2'.repeat(40), branch: 'working', base: 'prepared-only' } },
    } as AssessmentGitRecord;
    const before = structuredClone(record);
    assert.deepEqual(await assessmentGitContext(record, issue, async () => 'release'), {
      checkoutStartingPoint: { commit, ref: 'v1.0.0' },
      prBase: 'release',
    });
    assert.deepEqual(
      await assessmentGitContext(record, issue, async () => {
        throw Error('offline');
      }),
      {
        checkoutStartingPoint: { commit, ref: 'v1.0.0' },
        prBase: 'unknown',
      },
    );
    assert.deepEqual(record, before);
  });

  it('should use the original pr head and its non-default base without a diagnostic lookup', async () => {
    const pr = {
      ...issue,
      initiation: { kind: 'operator' },
      pullRequest: { headSha: commit, headRef: 'feature/example', baseRef: 'release' },
    } as ManagedIssue;
    const shown = await assessmentGitContext({} as AssessmentGitRecord, pr, async () => {
      assert.fail('retained base needs no optional read');
    });
    assert.deepEqual(shown, {
      checkoutStartingPoint: { commit, ref: 'feature/example' },
      prBase: 'release',
    });
    const incomplete = await assessmentGitContext(
      { project: { commit: '3'.repeat(40) } } as AssessmentGitRecord,
      pr,
    );
    assert.deepEqual(incomplete.checkoutStartingPoint, { commit: '3'.repeat(40), ref: undefined });
  });

  it('should preserve an adopted base and an effected delivery base without substituting its later head', async () => {
    for (const record of [
      { adoptedPullRequest: { head: commit, branch: 'feature/adopted', base: 'stable' } },
      {
        delivery: {
          creationAttempted: true,
          binding: { head: '2'.repeat(40), branch: 'working', base: 'stable' },
        },
      },
      {
        adoptedPullRequest: { head: commit, branch: 'feature/bound-later', base: 'stable' },
        delivery: { adopted: { head: commit, branch: 'feature/bound-later', base: 'stable' } },
      },
    ]) {
      const shown = await assessmentGitContext(record as AssessmentGitRecord, issue);
      assert.equal(shown.prBase, 'stable');
      assert.equal(
        shown.checkoutStartingPoint.commit,
        'adoptedPullRequest' in record && !('delivery' in record) ? commit : undefined,
      );
    }
  });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should render independent known and unknown git facts in ${runtime} without state or model inputs`, async () => {
      const record = {
        id: 'a'.repeat(64),
        threadId: 'thread',
        request: {},
        manualIssue: issue,
        project: { commit, ref: 'refs/remotes/origin/feature/example' },
      } as AssessmentGitRecord;
      const request = {
        action: 'assessment',
        operation: 'render',
        target: 'https://github.com/owner/repo/issues/3',
        result: { outcome: 'plan-ready', summary: 'Show both choices.' },
      };
      const context = {
        runtime,
        records: [record],
        admitted: [],
        session: 'thread',
        workspace: '/workspace',
        debug: true,
      };
      const before = structuredClone(record);
      const show = async (repositoryDefault?: () => Promise<string>) =>
        String(
          composeResponseBlocks(
            (await renderBoundAssessment(request, { ...context, repositoryDefault }))
              .responseBlocks,
          ),
        );
      const known = await show(async () => 'release');
      assert.match(known, new RegExp(`${commit} \\(origin/feature/example\\)`));
      assert.match(known, /PR base.*`release`/);
      const failed = await show(async () => {
        throw Error('optional lookup failed');
      });
      assert.match(failed, new RegExp(commit));
      assert.match(failed, /PR base.*`unknown`/);
      record.project = { commit } as AssessmentGitRecord['project'];
      assert.match(await show(), new RegExp(`${commit} \\(unknown\\)`));
      delete record.project;
      const missing = await show(async () => 'release');
      assert.match(missing, /Checkout starting point.*`unknown \(unknown\)`/);
      assert.match(missing, /PR base.*`release`/);
      const hidden = await renderBoundAssessment(request, {
        ...context,
        debug: false,
        repositoryDefault: async () => {
          assert.fail('debug off must not read diagnostics');
        },
      });
      assert.doesNotMatch(
        composeResponseBlocks(hidden.responseBlocks),
        /Checkout starting point|PR base|Debug/,
      );
      record.project = before.project;
      assert.deepEqual(record, before);
    });
});
