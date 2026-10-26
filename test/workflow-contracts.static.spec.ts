import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { testResourcePrefix } from '../scripts/test-resource-cleanup.ts';

interface Step {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

describe('workflow safety and coverage', () => {
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
    const workflow = parse(await readFile('.github/workflows/test-resource-cleanup.yml', 'utf8'));
    assert.ok(Object.values(workflow.permissions).every((value) => value === 'read'));
    const steps = workflow.jobs.cleanup.steps as Step[];
    const checkout = steps.find(({ uses }) => uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(checkout?.with?.['persist-credentials'], false);
  });

  it('should keep cleanup triggers aligned with source workflow names after renames', async () => {
    const cleanup = parse(await readFile('.github/workflows/test-resource-cleanup.yml', 'utf8'));
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
              .startsWith(testResourcePrefix(77, 100, 2)),
            `${example}: fixture issue must identify its source attempt`,
          );
        }
      }
    }
  });
});
