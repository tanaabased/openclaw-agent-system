import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import assert from 'node:assert/strict';

import { Value } from 'typebox/value';

import renderNativeAssessment from '../agent/tasks/assessment/assessment-render.ts';
import codexResponse from '../agent/tasks/response/codex-response.ts';
import openClawResponse from '../agent/tasks/response/openclaw-response.ts';
import { taskResponse, taskResponseOutput } from '../agent/tasks/response/task-response.ts';
import composeResponseBlocks, {
  responseBlocks,
} from '../channels/github/presentation/response-blocks.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

const target = 'https://github.com/owner/repo/issues/667';
const runtime = { entrypoint: '/plugin/runtime.mjs', pluginData: '/data', node: '/node' };
const caller = {
  sessionKey: 'issue',
  sessionId: 'incarnation',
  runId: 'current',
  toolCallId: 'compose',
};
const published =
  '> Exact **public** text.\n>\n> *[Reply ↗](https://github.com/owner/repo/issues/667#issuecomment-7) from [@agent](https://github.com/agent)*';
const output = (
  section: Parameters<typeof responseBlocks>[0],
  markdown: string,
  source?: string,
) => ({ responseBlocks: responseBlocks(section, markdown, source), presentation: markdown });

describe('task response assembly', () => {
  for (const host of ['codex', 'openclaw'] as const) {
    const assemble = (values: unknown[], blocks: unknown[] = [], fail = false) => {
      if (host === 'codex')
        return codexResponse(
          async (method, params) => {
            if (method === 'thread/turns/list') return { data: [{ id: 'current' }] };
            assert.equal(method, 'thread/items/list');
            assert.equal(params.turnId, 'current');
            assert.equal(params.sortDirection, 'asc');
            if (fail) throw new Error('history unavailable');
            return {
              data: values.map((value, index) => ({
                turnId: 'current',
                item: {
                  id: String(index),
                  type: 'commandExecution',
                  status: 'completed',
                  exitCode: 0,
                  command:
                    'node /plugin/runtime.mjs dispatch assessment render --plugin-data /data',
                  aggregatedOutput: JSON.stringify(value),
                },
              })),
            };
          },
          'thread',
          runtime,
          blocks,
        );
      return openClawResponse(
        async (method) => {
          assert.equal(method, 'chat.history');
          if (fail) throw new Error('history unavailable');
          return {
            sessionId: caller.sessionId,
            messages: [
              {
                role: 'toolResult',
                toolName: 'agent_system_dispatch',
                details: output('assessment', 'old plan'),
                __openclaw: { id: 'old', runId: 'old' },
              },
              { role: 'user', __openclaw: { id: 'input', runId: caller.runId } },
              ...values.map((value, index) => ({
                role: 'toolResult',
                toolName: 'agent_system_dispatch',
                details: value,
                __openclaw: { id: String(index), runId: caller.runId },
              })),
            ],
          };
        },
        caller,
        blocks,
      );
    };
    for (const mode of ['plan', 'work', 'auto'] as const) {
      it(`should assemble the complete ${host} ${mode} response without reversing prose or losing public text`, async () => {
        const assessment = renderNativeAssessment(
          {
            action: 'assessment',
            operation: 'render',
            target,
            result: {
              outcome: 'plan-ready',
              summary: 'Initial plan',
              reviewSummary: 'Assessment explanation',
              ...(mode === 'auto' ? { decision: { mode: 'work', reasons: ['bounded task'] } } : {}),
            },
          },
          host,
          {
            routing: {
              model: 'model',
              effort: 'high',
              complexity: 'low',
              profile: 'low',
              source: 'native',
              reason: 'bounded',
            },
          },
        );
        assert.equal(assessment.status, 'formatted');
        // #667: delivery tool results can precede the assessment in collection order.
        const values = [
          output('delivery-reply', published, 'announcement'),
          output('delivery', 'PR #698', 'pr'),
          assessment,
          output('work', 'Published assessment reply', 'assessment-reply'),
          output('debug', 'Debug configuration', 'debug'),
          output('delivery', 'PR #698', 'pr'),
        ];
        const result = await assemble(values, [
          { section: 'work', markdown: 'Implementation results' },
          { section: 'delivery', markdown: 'Private caveat after PR' },
        ]);
        assert.equal(result.status, 'response-composed');
        const text = result.presentation;
        const markers = [
          'Initial plan',
          'Model routing',
          ...(mode === 'auto' ? ['Auto mode decision'] : []),
          'Assessment explanation',
          'Published assessment reply',
          'Implementation results',
          'PR #698',
          'Private caveat after PR',
          published,
          'Debug configuration',
        ];
        let previous = -1;
        for (const marker of markers) {
          const position = text.indexOf(marker);
          assert.ok(position > previous, `${host}: missing or misplaced ${marker}`);
          previous = position;
        }
        assert.equal(text.split('PR #698').length - 1, 1);
        assert.ok(!text.includes('old plan'));
      });
    }
    it(`should keep ${host} clarification questions, malformed fallback and uncategorized prose`, async () => {
      const assessment = renderNativeAssessment(
        {
          action: 'assessment',
          operation: 'render',
          target,
          result: {
            outcome: 'clarification-needed',
            summary: 'Need a choice',
            questions: ['Which behavior?'],
          },
        },
        host,
      );
      const result = await assemble(
        [assessment, { responseBlocks: [{ bad: true }], presentation: published }],
        [{ markdown: 'Ordinary paragraph' }],
      );
      assert.ok(result.presentation.includes('Which behavior?'));
      assert.ok(result.presentation.includes(published));
      assert.ok(result.presentation.includes('Ordinary paragraph'));
      assert.ok(!result.presentation.includes('Debug'));
    });
    it(`should keep ${host} later turns independent of previous composition and initial plans`, async () => {
      const result = await assemble([
        { status: 'response-composed', presentation: 'previous composed plan' },
        output('delivery', 'Updated PR'),
      ]);
      assert.equal(result.presentation, 'Updated PR');
    });
    it(`should degrade ${host} history failure without losing authored findings or replaying effects`, async () => {
      const result = await assemble(
        [],
        [{ markdown: 'Completed work; original PR remains.' }],
        true,
      );
      assert.equal(result.status, 'response-composed');
      assert.ok(result.presentation.includes('Completed work; original PR remains.'));
      assert.match(result.presentation, /incomplete/);
    });
  }
  it('should retain prose order, unknown sections and repeated unkeyed text without interpreting headings', () => {
    assert.equal(
      composeResponseBlocks([
        { section: 'debug', markdown: 'last' },
        { section: 'new-kind', markdown: '> ## 🔬 Debug\nThis is ordinary user prose.' },
        { markdown: 'repeat' },
        'repeat',
        { section: 'assessment', markdown: 'first' },
      ]),
      'first\n\n> ## 🔬 Debug\nThis is ordinary user prose.\n\nrepeat\n\nrepeat\n\nlast',
    );
  });
  it('should replace a draft with its exact confirmed source without duplicating the card', () => {
    assert.equal(
      composeResponseBlocks([
        ...responseBlocks('work', 'draft', 'reply'),
        ...responseBlocks('work', published, 'reply'),
      ]),
      published,
    );
  });
  it('should preserve completed effects and all available text after a formatter or partial-history failure', async () => {
    let effects = 0;
    const completed = () => {
      effects++;
      return output('delivery-reply', published);
    };
    const receipt = completed();
    const result = await taskResponse(
      'codex',
      [{ markdown: 'Finding and caveat' }],
      async function* () {
        yield receipt;
        throw new Error('next page unavailable');
      },
      () => {
        throw new Error('formatter unavailable');
      },
    );
    assert.equal(effects, 1);
    assert.ok(result.presentation.includes(published));
    assert.ok(result.presentation.includes('Finding and caveat'));
  });
  it('should preserve unresolved operational notices without a presentation field', () => {
    assert.deepEqual(
      taskResponseOutput({ notice: { message: 'Push uncertain; reconcile original receipt.' } }),
      [{ section: 'work', markdown: 'Push uncertain; reconcile original receipt.' }],
    );
  });
  it('should retain readable fragments when sibling blocks are malformed and no full fallback exists', () => {
    const text = composeResponseBlocks(
      taskResponseOutput({
        responseBlocks: [{ markdown: 'Available finding' }, null, { missing: true }],
      }),
    );
    assert.ok(text.includes('Available finding'));
    assert.match(text, /blocks were unavailable/);
  });
  it('should preserve a separate operational notice alongside an existing presentation', () => {
    const blocks = taskResponseOutput({
      presentation: 'PR retained',
      notice: { message: 'Push uncertain' },
      notices: [{ message: 'Push uncertain' }],
    });
    assert.equal(composeResponseBlocks(blocks), 'PR retained\n\nPush uncertain');
  });
  it('should keep oversized markdown intact in composition and return an explicit native fallback rather than trim', async () => {
    const markdown = 'complete finding '.repeat(2000) + 'LAST FINDING';
    assert.equal(composeResponseBlocks([{ markdown }]), markdown);
    const result = await taskResponse('openclaw', [{ markdown }], async function* () {});
    assert.equal(result.status, 'presentation-unavailable');
    assert.match(result.instructions, /keep all prose and exact public replies/);
  });
  it('should accept empty and prose-only requests but reject native bindings and source overrides', () => {
    assert.ok(Value.Check(dispatchModelParameters, { action: 'response' }));
    assert.ok(
      Value.Check(dispatchModelParameters, {
        action: 'response',
        blocks: [{ markdown: 'ordinary prose' }],
      }),
    );
    for (const extra of [
      { id: 'a'.repeat(64) },
      { sessionKey: 'other' },
      { threadId: 'other' },
      { workspace: '/other' },
    ])
      assert.ok(!Value.Check(dispatchModelParameters, { action: 'response', ...extra }));
    assert.ok(
      !Value.Check(dispatchModelParameters, {
        action: 'response',
        blocks: [{ markdown: 'text', source: 'forged' }],
      }),
    );
  });
});

describe('native response recovery boundaries', () => {
  for (const dispatcher of ['tool_call', 'dispatch_action']) {
    it(`should assemble ${dispatcher} output only from the current run and owned tool source`, async () => {
      const wrapped = (name: string, source: string, runId = caller.runId) => ({
        role: 'toolResult',
        toolName: dispatcher,
        details: {
          tool: { name, source },
          result: {
            details: output(
              'assessment',
              name === 'agent_system_dispatch' && source === 'openclaw' && runId === caller.runId
                ? 'Current plan'
                : 'Wrong plan',
            ),
          },
        },
        __openclaw: { runId },
      });
      const result = await openClawResponse(
        async () => ({
          sessionId: caller.sessionId,
          messages: [
            { role: 'user', __openclaw: { runId: caller.runId } },
            wrapped('agent_system_dispatch', 'openclaw', 'old'),
            wrapped('other', 'openclaw'),
            wrapped('agent_system_dispatch', 'mcp'),
            wrapped('agent_system_dispatch', 'openclaw'),
          ],
        }),
        caller,
      );
      assert.equal(result.presentation, 'Current plan');
    });
  }
  it('should retain supplied prose through read-only recomposition without duplicating the prior response', async () => {
    const first = await taskResponse(
      'codex',
      [{ markdown: 'Additional finding' }, { markdown: 'Additional finding' }],
      async function* () {
        yield output('delivery', 'PR');
      },
    );
    const second = await taskResponse('codex', [], async function* () {
      yield output('delivery', 'PR');
      yield first;
    });
    assert.equal(second.presentation, first.presentation);
    assert.equal(second.presentation.split('Additional finding').length - 1, 2);
  });
  it('should preserve current-run pages and hydrated public text without replaying another run', async () => {
    const result = await openClawResponse(async (method, params) => {
      if (method === 'chat.message.get')
        return {
          ok: true,
          message: {
            role: 'toolResult',
            toolName: 'agent_system_dispatch',
            details: output('delivery-reply', published),
            __openclaw: { id: 'reply', runId: caller.runId },
          },
        };
      if (params.cursor)
        return {
          sessionId: caller.sessionId,
          messages: [
            { role: 'user', __openclaw: { id: 'input', runId: caller.runId } },
            {
              role: 'toolResult',
              toolName: 'agent_system_dispatch',
              details: output('assessment', 'Plan'),
              __openclaw: { id: 'plan', runId: caller.runId },
            },
          ],
        };
      return {
        sessionId: caller.sessionId,
        olderCursor: 'older',
        messages: [
          {
            role: 'toolResult',
            toolName: 'agent_system_dispatch',
            __openclaw: { id: 'reply', runId: caller.runId, truncated: true },
          },
        ],
      };
    }, caller);
    assert.equal(result.presentation, 'Plan\n\n' + published);
  });
  it('should preserve a partial native page when a subsequent page fails', async () => {
    const result = await codexResponse(
      async (method, params) => {
        if (method === 'thread/turns/list') return { data: [{ id: 'current' }] };
        if (params.cursor) throw new Error('next page unavailable');
        return {
          nextCursor: 'next',
          data: [
            {
              turnId: 'current',
              item: {
                type: 'commandExecution',
                status: 'completed',
                exitCode: 0,
                command: 'node /plugin/runtime.mjs delivery announce --plugin-data /data',
                aggregatedOutput: JSON.stringify(output('delivery-reply', published)),
              },
            },
          ],
        };
      },
      'thread',
      runtime,
    );
    assert.ok(result.presentation.includes(published));
    assert.match(result.presentation, /incomplete/);
  });
  it('should refuse foreign native output and recover available findings without another resource lookup', async () => {
    const result = await codexResponse(
      async (method) =>
        method === 'thread/turns/list'
          ? { data: [{ id: 'current' }] }
          : { data: [{ turnId: 'foreign', item: output('assessment', 'foreign plan') }] },
      'thread',
      runtime,
      [{ markdown: 'Own finding' }],
    );
    assert.ok(!result.presentation.includes('foreign plan'));
    assert.ok(result.presentation.includes('Own finding'));
    assert.match(result.presentation, /incomplete/);
  });
});

describe('response runtime invocation', () => {
  it('should expose response as a read-only codex dispatch action without internal selectors', () => {
    const input = { blocks: [{ markdown: 'Additional text' }] };
    assert.deepEqual(
      codexRuntimeRequest('dispatch', ['response', '--plugin-data', '/data'], input).request,
      { ...input, action: 'response' },
    );
  });
});
