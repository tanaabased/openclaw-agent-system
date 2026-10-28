import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { fixturePrefix } from '../scripts/gha-fixture-cleanup.ts';

interface Step {
  id?: string;
  if?: string;
  'continue-on-error'?: boolean;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

describe('workflow safety and coverage', () => {
  it('should recover only a failed normal clawhub publication and propagate fallback failures', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
    const steps = workflow.jobs['publish-clawhub'].steps as Step[];
    const publishers = steps.filter(({ uses }) => uses === 'tanaabased/actions/publish-clawhub@v1');
    const [normal, fallback] = publishers;
    assert.equal(publishers.length, 2, 'one normal publication and at most one fallback');
    assert.equal(normal?.['continue-on-error'], true);
    assert.notEqual(fallback?.['continue-on-error'], true);
    assert.equal(normal?.with?.tarball, '${{ steps.pack.outputs.tarball-path }}');
    assert.equal(fallback?.with?.tarball, '${{ runner.temp }}/clawhub-fallback.tgz');
    const recovery = steps.slice(steps.indexOf(normal!) + 1);
    assert.ok(recovery.some(({ run }) => run?.includes('clawhub-fallback-task.ts')));
    assert.ok(recovery.some(({ env }) => env?.AGENT_SYSTEM_PACKAGE_WITHOUT_SOURCE_MAPS === 'true'));
    for (const step of recovery) {
      assert.equal(step.if, `\${{ steps.${normal!.id}.outcome == 'failure' }}`);
      assert.notEqual(step['continue-on-error'], true);
    }
    for (const key of [
      'owner',
      'source-repo',
      'source-commit',
      'clawhub-token',
      'tags',
      'wait-timeout',
    ]) {
      assert.equal(fallback?.with?.[key], normal?.with?.[key], `${key} must survive fallback`);
    }
  });

  it('should keep source checks read-only and native coverage on both supported platforms', async () => {
    const units = parse(await readFile('.github/workflows/pr-unit-tests.yml', 'utf8'));
    const components = parse(await readFile('.github/workflows/pr-component-tests.yml', 'utf8'));
    const metadata = JSON.parse(await readFile('package.json', 'utf8'));
    const entries = components.jobs.components.strategy.matrix.include as Array<{
      suite: string;
      os: string;
    }>;
    for (const { suite } of entries)
      assert.equal(typeof metadata.scripts[`test:${suite}`], 'string');
    for (const platform of ['ubuntu-', 'macos-']) {
      assert.ok(entries.some(({ suite, os }) => suite === 'os' && os.startsWith(platform)));
    }
    for (const workflow of [units, components]) {
      assert.deepEqual(workflow.permissions, { contents: 'read' });
    }
  });

  for (const kind of ['codex', 'os', 'openclaw', 'notifications']) {
    it(`should isolate ${kind} example credentials and consume the packed artifact`, async () => {
      const workflow = parse(await readFile(`.github/workflows/pr-examples-${kind}.yml`, 'utf8'));
      assert.deepEqual(workflow.permissions, { contents: 'read' });
      const job = workflow.jobs.examples;
      const steps = job.steps as Step[];
      const examples = steps.filter(({ run }) => /^leia\s/m.test(run ?? ''));
      assert.ok(examples.length > 0);
      for (const example of examples) {
        assert.equal(example.env?.AGENT_SYSTEM_PACKAGE, '${{ steps.pack.outputs.tarball-path }}');
      }
      // hosted credentials belong only to runtime execution, never shared setup.
      for (const env of [
        workflow.env,
        job.env,
        ...steps.filter((step) => kind === 'os' || !examples.includes(step)).map(({ env }) => env),
      ]) {
        assert.ok(!JSON.stringify(env ?? {}).includes('secrets.'));
      }
      if (kind === 'os') {
        const platforms = job.strategy.matrix.os as string[];
        for (const platform of ['ubuntu-', 'macos-']) {
          assert.ok(platforms.some((os) => os.startsWith(platform)));
        }
      }
    });
  }

  it('should execute cleanup from the default branch with read-only workflow permissions', async () => {
    const workflow = parse(await readFile('.github/workflows/gha-fixture-cleanup.yml', 'utf8'));
    assert.ok(Object.values(workflow.permissions).every((value) => value === 'read'));
    const steps = workflow.jobs.cleanup.steps as Step[];
    const checkout = steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(checkout?.with?.['persist-credentials'], false);
    assert.deepEqual(
      steps.find(({ uses }) => uses === './.github/actions/gha-fixture-cleanup')?.env,
      { GH_TOKEN: '${{ secrets.GH_TOKEN_TANAABOT }}' },
    );
  });

  it('should keep cleanup triggers aligned with source workflow names after renames', async () => {
    const cleanup = parse(await readFile('.github/workflows/gha-fixture-cleanup.yml', 'utf8'));
    const names = await Promise.all(
      ['codex', 'os', 'openclaw', 'notifications'].map(
        async (kind) =>
          parse(await readFile(`.github/workflows/pr-examples-${kind}.yml`, 'utf8')).name,
      ),
    );
    assert.deepEqual([...cleanup.on.workflow_run.workflows].sort(), names.sort());
  });

  it('should enumerate distinct existing examples in their owning workflows', async () => {
    const selected = new Set<string>();
    for (const kind of ['codex', 'os', 'openclaw', 'notifications']) {
      const workflow = parse(await readFile(`.github/workflows/pr-examples-${kind}.yml`, 'utf8'));
      const examples = workflow.jobs.examples.strategy.matrix.example as string[];
      assert.ok(Array.isArray(examples) && examples.length > 0);
      for (const example of examples) {
        assert.match(example, /^[a-z][a-z0-9-]+$/u);
        assert.ok(!selected.has(example), `${example} is selected by more than one workflow`);
        selected.add(example);
        const owner = example.startsWith('openclaw-notifications-')
          ? 'notifications'
          : example.split('-')[0];
        assert.equal(owner, kind);
        const readme = await readFile(`examples/${example}/README.md`, 'utf8');
        const issueTitles = readme.matchAll(
          /api --method POST repos\/tanaabased\/big-test-bucket\/issues -f "title=([^"\n]+)"/gu,
        );
        for (const [, title] of issueTitles) {
          assert.ok(
            title!
              .replace('$GITHUB_REPOSITORY_ID', '77')
              .replace('$GITHUB_RUN_ID', '100')
              .replace('$GITHUB_RUN_ATTEMPT', '2')
              .startsWith(fixturePrefix(77, 100, 2)),
            `${example}: fixture issue must identify its source attempt`,
          );
        }
      }
    }
  });
});
