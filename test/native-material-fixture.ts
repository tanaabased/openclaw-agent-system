import { bindNativeMaterial, nativeMaterialResponse } from '../agent/native-material.ts';
import contextMaterialTransport from '../agent/context-material-transport.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { getTextContent, LLMock } from '@copilotkit/aimock';

import captureFixtureErrors from '../scripts/aimock-fixture-errors.ts';
import httpResponses from '../scripts/aimock-http-responses.ts';
import withToolSearch from '../scripts/aimock-tool-search.ts';

import type { OpenClawAIMockScenario } from '../scripts/aimock-scenario.ts';

/** Exercise real native output limits with synthetic credentials and isolated chat state. */
export default async function nativeMaterialFixture(input: {
  request: Record<string, unknown>;
  run(request: Record<string, unknown>, tool?: string): unknown | Promise<unknown>;
  verify?(context: Record<string, unknown>): void;
  scenario?: OpenClawAIMockScenario;
  prompt?: string;
  finalText?: string;
  minimumPages?: number;
}) {
  const materialScenario: OpenClawAIMockScenario = {
    id: 'native-material',
    model: { match: /gpt-5\.5/u, reference: 'openai/gpt-5.5' },
    systemPromptSignals: [],
    finalResponses: ['native-material-complete'],
    toolCalls: [{ id: 'call_material_context', name: 'agent_system_dispatch' }],
    fixtures: [
      {
        match: {
          predicate: (request) =>
            request.messages.some(
              (message) =>
                message.role === 'tool' && message.tool_call_id === 'call_material_context',
            ),
        },
        response: (request) => {
          const message = request.messages.find(
            (message) =>
              message.role === 'tool' && message.tool_call_id === 'call_material_context',
          )!;
          const content = getTextContent(message.content) ?? '';
          assert.ok(content.startsWith('{'), content);
          input.verify?.(JSON.parse(content));
          return { content: 'native-material-complete' };
        },
      },
      {
        match: { predicate: () => true },
        response: {
          toolCalls: [
            {
              id: 'call_material_context',
              name: 'agent_system_dispatch',
              arguments: JSON.stringify(input.request),
            },
          ],
        },
      },
    ],
  };
  const root = await mkdtemp(join(tmpdir(), 'pickup-model-'));
  await mkdir(join(root, 'codex'));
  const mock = new LLMock({ host: '127.0.0.1', port: 0, strict: true, logLevel: 'warn' });
  const { scenario, errors } = captureFixtureErrors(
    withToolSearch(input.scenario ?? materialScenario),
  );
  mock.addFixtures([...scenario.fixtures]);
  mock.mount('/v1/responses', httpResponses);
  const base = await mock.start();
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/@openai/codex/bin/codex.js'),
      '-c',
      `openai_base_url="${base}/v1"`,
      'app-server',
      '--listen',
      'stdio://',
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: join(root, 'codex'),
        OPENAI_API_KEY: 'fixture',
        CODEX_API_KEY: 'fixture',
      },
    },
  );
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });
  let sequence = 0;
  let pages = 0;
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }
  >();
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolveResult, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolveResult, reject });
      send({ id, method, params });
    });
  let complete: (value: Record<string, unknown>) => void;
  let fail: (error: unknown) => void;
  const finished = new Promise<Record<string, unknown>>((resolveResult, reject) => {
    complete = resolveResult;
    fail = reject;
  });
  void finished.catch(() => {});
  const timer = setTimeout(() => {
    const error = new Error(
      `native assessment did not finish: ${JSON.stringify(errors)} ${stderr}`,
    );
    for (const request of pending.values()) request.reject(error);
    fail(error);
  }, 5000);
  child.once('error', (error) => fail(error));
  const materialReceipts: unknown[] = [];
  lines.on('line', async (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'item/tool/call') {
        let result: unknown;
        if (message.params.tool === 'openclaw_tool_search') {
          result = {
            results: ['agent_system_intake', 'agent_system_dispatch', 'agent_system_github'].map(
              (name) => ({
                query: name,
                candidates: [
                  { id: `openclaw:${name}`, name, source: 'openclaw', input: '{ args }' },
                ],
              }),
            ),
          };
        } else {
          assert.equal(message.params.tool, 'tool_call');
          const name = String(message.params.arguments.id).replace(/^openclaw:/u, '');
          assert.ok(['agent_system_dispatch', 'agent_system_github'].includes(name));
          const args = message.params.arguments.args;
          if (args.material) pages += 1;
          const bound = await bindNativeMaterial(
            name,
            args,
            (async function* () {
              yield* materialReceipts;
            })(),
          );
          const output = contextMaterialTransport(
            nativeMaterialResponse(await input.run(bound, name), name, args),
            { tool: name },
          );
          materialReceipts.unshift(output);
          result = {
            tool: {
              id: `openclaw:${name}`,
              name,
              source: 'openclaw',
            },
            result: {
              content: [{ type: 'text', text: JSON.stringify(output) }],
              details: output,
            },
          };
        }
        send({
          id: message.id,
          result: {
            success: true,
            contentItems: [{ type: 'inputText', text: JSON.stringify(result, null, 2) }],
          },
        });
      } else if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) request.reject(message.error);
        else request.resolve(message.result);
      } else if (message.method === 'turn/completed') complete(message.params.turn);
      else if (message.method === 'error')
        fail(new Error(JSON.stringify({ error: message.params, fixtureErrors: errors })));
    } catch (error) {
      fail(error);
    }
  });
  try {
    await rpc('initialize', {
      clientInfo: { name: 'pickup_fixture', version: '1' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
    const thread = await rpc('thread/start', {
      model: 'gpt-5.5',
      modelProvider: 'openai',
      cwd: root,
      ephemeral: true,
      approvalPolicy: 'never',
      // Avoid collision with the recognized model's built-in tool_search.
      dynamicTools: ['openclaw_tool_search', 'tool_call'].map((name) => ({
        name,
        description: 'fixture tool',
        inputSchema: { type: 'object', additionalProperties: true },
      })),
    });
    await rpc('turn/start', {
      threadId: (thread.thread as { id: string }).id,
      input: [
        {
          type: 'text',
          text: input.prompt ?? 'Read the complete context.',
        },
      ],
    });
    const turn = await finished;
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.ok(
      (turn.items as Array<{ text?: string }>).some(
        (item: { text?: string }) => item.text === (input.finalText ?? 'native-material-complete'),
      ),
    );
    assert.ok(
      pages >= (input.minimumPages ?? 1),
      'the native exchange must read required material pages',
    );
    assert.deepEqual(errors, []);
    assert.ok(
      mock.getRequests().every((entry) => entry.response.status === 200 && entry.response.fixture),
    );
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
    await exited;
    await mock.stop();
    await rm(root, { recursive: true, force: true });
  }
}
