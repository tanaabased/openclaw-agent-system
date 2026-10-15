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

  it('should run native codex acceptance through the shared leia matrix step', async () => {
    const source = await readFile('.github/workflows/pr-examples-tests.yml', 'utf8');
    const workflow = parse(source) as ExampleWorkflow;
    const steps = workflow.jobs?.examples?.steps ?? [];
    const installOpenClaw = steps.find(({ name }) => name === 'Install OpenClaw');
    const example = steps.find(({ name }) => name === 'Run Leia-backed example');
    const diagnostics = steps.find(({ name }) => name === 'RUNNING A LEVEL THREE DIAGNOSTICS');

    assert.equal('codex' in (workflow.jobs ?? {}), false);
    assert.equal(
      steps.some(({ name }) => name === 'Authenticate isolated Codex'),
      false,
    );
    assert.equal(
      steps.some(({ name }) => name === 'Run Leia-backed Codex example'),
      false,
    );
    assert.equal(installOpenClaw?.if, undefined);
    assert.equal(example?.if, undefined);
    assert.equal(example?.env?.CODEX_HOME, '${{ runner.temp }}/codex-home');
    assert.equal(example?.env?.CODEX_TOOLS_CODEX_HOME, '${{ runner.temp }}/codex-home');
    assert.equal(example?.env?.OPENAI_API_KEY, '${{ secrets.TANAAB_ALTERNATE_MALE_KEY }}');
    assert.equal(example?.env?.OPENAI_MODEL, 'gpt-5.4-nano');
    assert.equal(example?.run, 'leia "examples/${{ matrix.example }}/README.md" --stdin --retry 0');
    assert.equal(diagnostics?.if, 'failure()');

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
