import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { parse } from 'yaml';

import resolveAgentEnvironment from '../environment/resolve.ts';
import parseAgentManifest from '../manifest/parse.ts';

interface ParsedLeiaSuite {
  tests: Record<string, Array<{ command: string; skip: boolean }>>;
}

const Leia = createRequire(import.meta.url)('@lando/leia') as new () => {
  parse(files: string[]): ParsedLeiaSuite[];
};

interface WorkflowStep {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
}

interface ExampleWorkflow {
  permissions?: { contents?: string };
  concurrency?: { 'cancel-in-progress'?: boolean };
  jobs?: {
    examples?: {
      name?: string;
      'runs-on'?: string;
      steps?: WorkflowStep[];
      strategy?: {
        'fail-fast'?: boolean;
        matrix?: {
          example?: string[];
          os?: string[];
        };
      };
    };
  };
}

describe('example workflows', () => {
  it('should resolve only each token-only fixture account and reject missing or empty tokens', async () => {
    const tokens = {
      GH_TOKEN_EMORI: 'synthetic-emori-token',
      GH_TOKEN_TANAABOT: 'synthetic-tanaabot-token',
    };
    for (const [path, token, username] of [
      ['examples/tool/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/github/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/github/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
    ] as const) {
      const parsed = parseAgentManifest(await readFile(path, 'utf8'));
      assert.equal(parsed.status, 'valid', path);
      assert.ok(parsed.manifest);
      assert.equal(parsed.manifest.environment?.op, undefined);
      assert.equal(parsed.manifest.github?.username, username);
      assert.equal(parsed.manifest.github?.token, token);
      const resolved = resolveAgentEnvironment(parsed.manifest, tokens);
      assert.equal(resolved.status, 'resolved', path);
      assert.ok(resolved.status === 'resolved');
      assert.deepEqual(resolved.environment.values, { [token]: tokens[token] });
      for (const missing of [undefined, '']) {
        const result = resolveAgentEnvironment(parsed.manifest, { ...tokens, [token]: missing });
        assert.equal(result.status, 'invalid', path);
        assert.ok(result.status === 'invalid');
        const expectedCode =
          missing === undefined ? 'environment-reference-missing' : 'environment-required-missing';
        assert.ok(result.diagnostics.some(({ code }) => code === expectedCode));
      }
    }
  });

  it('should stage only installation and doctor on both operating systems without hosted secrets', async () => {
    const source = await readFile('.github/workflows/pr-examples-os.yml', 'utf8');
    const workflow = parse(source) as ExampleWorkflow;
    const steps = workflow.jobs?.examples?.steps ?? [];
    const example = steps.find(({ name }) => name === 'Run Leia-backed example');
    const matrix = workflow.jobs?.examples?.strategy?.matrix;

    assert.equal(workflow.permissions?.contents, 'read');
    assert.equal(workflow.concurrency?.['cancel-in-progress'], true);
    assert.deepEqual(matrix?.os, ['macos-26', 'ubuntu-24.04']);
    assert.deepEqual(matrix?.example, ['os-install', 'os-doctor']);
    assert.equal(workflow.jobs?.examples?.strategy?.['fail-fast'], false);
    assert.ok(example);
    assert.equal(example?.if, undefined);
    assert.equal(example?.env?.AGENT_SYSTEM_PACKAGE, '${{ steps.pack.outputs.tarball-path }}');
    assert.equal(
      example?.env?.DEFAULT_CREDENTIAL_STORE,
      "${{ runner.os == 'macOS' && 'keychain' || 'secret-service' }}",
    );
    assert.equal(example?.run, 'leia "examples/${{ matrix.example }}/README.md" --stdin --retry 0');
    for (const step of steps) {
      assert.ok(!Object.values(step.env ?? {}).some((value) => String(value).includes('secrets.')));
    }
    for (const scenario of matrix?.example ?? []) {
      const suites = new Leia().parse([resolve('examples', scenario, 'README.md')]);
      assert.equal(suites.length, 1, scenario);
      assert.ok(
        suites[0]?.tests.test?.some(({ skip }) => !skip),
        scenario,
      );
    }
  });

  it('should retain codex heartbeat assertions while runtime ci selection is deferred', () => {
    const suites = new Leia().parse([resolve('examples', 'codex', 'README.md')]);
    assert.equal(suites.length, 1);
    assert.ok(suites[0]?.tests.setup?.some(({ skip }) => !skip));
    const heartbeatTests = suites[0]?.tests.test?.filter(
      ({ command, skip }) => !skip && command.includes('intake quiet-response'),
    );
    assert.ok(
      heartbeatTests?.some(
        ({ command }) =>
          command.includes('.status == "quiet"') &&
          command.includes('<decision>DONT_NOTIFY</decision>') &&
          command.includes('test ! -e "$root/quiet-data"'),
      ),
    );
    assert.ok(
      heartbeatTests?.some(
        ({ command }) =>
          command.includes('.status == "not-quiet"') &&
          command.includes('"status":"completed","changed":true') &&
          command.includes('has("response") | not'),
      ),
    );
  });
});
