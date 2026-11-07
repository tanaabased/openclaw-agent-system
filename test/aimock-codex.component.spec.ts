import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LLMock } from '@copilotkit/aimock';

import httpResponses from '../scripts/aimock-http-responses.ts';

describe('hosted codex mock configuration', () => {
  it('should initialize authored configurations and complete a native turn over http', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimock-codex-'));
    await mkdir(join(root, 'codex'));
    const mock = new LLMock({ host: '127.0.0.1', port: 0, strict: true, logLevel: 'warn' });
    let upgrades = 0;
    mock.mount('/v1/responses', {
      ...httpResponses,
      async handleUpgrade(...args) {
        upgrades += 1;
        return httpResponses.handleUpgrade!(...args);
      },
    });
    mock.addFixture({
      match: { model: 'gpt-5.5', userMessage: 'Return the transport probe receipt.' },
      response: { content: 'native-http-receipt' },
    });
    const base = await mock.start();
    const run = (args: string[], input?: string) =>
      new Promise<string>((resolveOutput, reject) => {
        const child = execFile(
          process.execPath,
          [
            resolve('node_modules/@openai/codex/bin/codex.js'),
            '-c',
            'features.plugins=false',
            ...args,
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              CODEX_HOME: join(root, 'codex'),
              OPENAI_API_KEY: 'agent-system-aimock-test',
              CODEX_API_KEY: 'agent-system-aimock-test',
            },
            timeout: 5000,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}\n${stdout}`));
            else resolveOutput(stdout);
          },
        );
        if (input) {
          let received = '';
          child.stdout!.on('data', (chunk: Buffer) => {
            received += chunk.toString();
            if (
              received
                .split('\n')
                .slice(0, -1)
                .some((line) => JSON.parse(line).id === 1)
            )
              child.stdin!.end();
          });
          child.stdin!.write(input);
        } else child.stdin!.end();
      });
    try {
      let nativeArgs: string[] = [];
      for (const scenario of [
        'openclaw-project-picker',
        'openclaw-automation-command-chat',
        'openclaw-runtimes',
        'openclaw-lifecycle-approvals',
      ]) {
        const readme = await readFile(`examples/${scenario}/README.md`, 'utf8');
        const configured = /appServer\.args '([^']+)' --strict-json/u.exec(readme)?.[1];
        assert.ok(configured, scenario);
        const args = (JSON.parse(configured) as string[]).map((arg) =>
          arg.replace('http://127.0.0.1:4010', base),
        );
        const initialized = await run(
          args,
          JSON.stringify({
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'agent_system_fixture', version: '1' } },
          }) + '\n',
        );
        const reply = initialized
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.ok(
          reply.some((item) => item.id === 1 && item.result?.userAgent),
          initialized,
        );
        nativeArgs = args.slice(0, args.indexOf('app-server'));
      }
      const output = await run([
        ...nativeArgs,
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--json',
        '-m',
        'gpt-5.5',
        'Return the transport probe receipt.',
      ]);
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(
        events.some((event) => event.type === 'turn.completed'),
        output,
      );
      assert.ok(
        events.some((event) => event.item?.text === 'native-http-receipt'),
        output,
      );
      assert.ok(upgrades > 0, 'native Codex must exercise the rejected upgrade');
      const requests = mock.getRequests();
      assert.ok(requests.length > 0);
      assert.ok(requests.every((entry) => entry.method === 'POST' && entry.response.fixture));
    } finally {
      await mock.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
