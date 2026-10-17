import assert from 'node:assert/strict';

import {
  getTextContent,
  matchFixture,
  type ChatCompletionRequest,
  type Fixture,
  type FixtureResponse,
} from '@copilotkit/aimock';

import type { OpenClawAIMockScenario, OpenClawAIMockToolCall } from './aimock-scenario.ts';
import { matchesOpenClawAIMockToolCallId } from './aimock-tool-result.ts';

const discoveryPrefix = 'call_aimock_discover_';
const preExecutionDenial = /^(?:Error: )?Denied by user\. The tool call did not run\.(?:\n|$)/u;

function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function controls(request: ChatCompletionRequest): boolean {
  return ['tool_search', 'tool_call'].every((name) =>
    request.tools?.some((tool) => tool.function.name === name),
  );
}

function currentMessages(request: ChatCompletionRequest) {
  return request.messages.slice(
    Math.max(
      0,
      request.messages.findLastIndex((message) => message.role === 'user'),
    ),
  );
}

function discoveryResult(request: ChatCompletionRequest) {
  return currentMessages(request).find(
    (message) => message.role === 'tool' && message.tool_call_id?.startsWith(discoveryPrefix),
  );
}

function catalog(
  request: ChatCompletionRequest,
  message = discoveryResult(request),
): Map<string, string> {
  if (!message) return new Map();
  const payload = parse(getTextContent(message.content) ?? '');
  assert.ok(Array.isArray(payload.results), 'tool search must return grouped results');
  const entries = new Map<string, string>();
  for (const group of payload.results) {
    assert.ok(typeof group.query === 'string' && Array.isArray(group.candidates));
    for (const candidate of group.candidates) {
      if (candidate.name !== group.query) continue;
      assert.equal(candidate.source, 'openclaw');
      assert.equal(typeof candidate.id, 'string');
      assert.equal(typeof candidate.input, 'string');
      assert.ok(!entries.has(candidate.name), 'tool search returned an ambiguous name');
      entries.set(candidate.name, candidate.id);
    }
  }
  return entries;
}

/** Present real discovered tools and verified inner results to scenario assertions. */
export function normalizeToolSearchRequest(
  request: ChatCompletionRequest,
  expectedDeniedToolCalls: readonly OpenClawAIMockToolCall[] = [],
): ChatCompletionRequest {
  if (!controls(request)) return request;
  const available = catalog(request);
  const discoveredIds = new Map(
    request.messages
      .filter(
        (message) => message.role === 'tool' && message.tool_call_id?.startsWith(discoveryPrefix),
      )
      .flatMap((message) =>
        [...catalog(request, message)].map(([name, id]) => [id, name] as const),
      ),
  );
  const calls = new Map(
    request.messages.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => [call.id, call] as const),
    ),
  );
  function unwrap(callId: string, argumentText: string, content: string) {
    const args = parse(argumentText);
    const name = discoveredIds.get(String(args.id));
    assert.ok(name, 'wrapped call must target a discovered tool');
    const expectedDenial = expectedDeniedToolCalls.some(
      (call) => call.name === name && matchesOpenClawAIMockToolCallId(callId, call.id),
    );
    // approval may stop the call before tool_call can produce its execution envelope.
    if (expectedDenial && preExecutionDenial.test(content)) {
      return { name, arguments: JSON.stringify(args.args ?? {}), content };
    }
    const envelope = parse(content);
    if (
      expectedDenial &&
      envelope.status === 'error' &&
      envelope.tool === 'tool_call' &&
      typeof envelope.error === 'string' &&
      preExecutionDenial.test(envelope.error)
    ) {
      return { name, arguments: JSON.stringify(args.args ?? {}), content: envelope.error };
    }
    const tool = envelope.tool as Record<string, unknown> | undefined;
    assert.ok(
      tool && tool.id === args.id && tool.name === name,
      `wrapped result must identify the requested tool: ${JSON.stringify({
        callId: callId.slice(0, 256),
        expected: { id: String(args.id).slice(0, 256), name: name.slice(0, 256) },
        actual: {
          id: typeof tool?.id === 'string' ? tool.id.slice(0, 256) : undefined,
          name: typeof tool?.name === 'string' ? tool.name.slice(0, 256) : undefined,
          status: typeof envelope.status === 'string' ? envelope.status.slice(0, 64) : undefined,
          error: typeof envelope.error === 'string' ? envelope.error.slice(0, 1024) : undefined,
        },
      })}`,
    );
    const result = envelope.result as { content?: unknown; isError?: boolean } | undefined;
    assert.ok(
      result && Array.isArray(result.content),
      'wrapped result must contain the executed tool result',
    );
    const text = getTextContent(result.content) ?? '';
    assert.ok(
      result.isError !== true || (expectedDenial && text.startsWith('Denied by user.')),
      'the wrapped tool call failed',
    );
    return { name, arguments: JSON.stringify(args.args ?? {}), content: text };
  }
  return {
    ...request,
    tools: [
      ...(request.tools ?? []),
      ...[...available.keys()]
        .filter((name) => !request.tools?.some((tool) => tool.function.name === name))
        .map((name) => ({ type: 'function' as const, function: { name } })),
    ],
    messages: request.messages.flatMap((message) => {
      if (message.role === 'tool' && message.tool_call_id?.startsWith(discoveryPrefix)) return [];
      if (message.role === 'assistant') {
        const toolCalls = message.tool_calls?.filter(
          (call) => !call.id.startsWith(discoveryPrefix),
        );
        if (message.tool_calls?.length && !toolCalls?.length) return [];
        return [
          {
            ...message,
            tool_calls: toolCalls?.map((call) => {
              if (call.function.name !== 'tool_call') return call;
              const result = request.messages.find(
                (candidate) => candidate.role === 'tool' && candidate.tool_call_id === call.id,
              );
              if (!result) return call;
              const projected = unwrap(
                call.id,
                call.function.arguments,
                getTextContent(result.content) ?? '',
              );
              return {
                ...call,
                function: { name: projected.name, arguments: projected.arguments },
              };
            }),
          },
        ];
      }
      const call = calls.get(message.tool_call_id ?? '');
      if (message.role !== 'tool' || call?.function.name !== 'tool_call') return [message];
      const projected = unwrap(
        call.id,
        call.function.arguments,
        getTextContent(message.content) ?? '',
      );
      return [{ ...message, content: projected.content }];
    }),
  };
}

function wrapResponse(request: ChatCompletionRequest, response: FixtureResponse): FixtureResponse {
  if (!controls(request) || !('toolCalls' in response) || !response.toolCalls) return response;
  const available = catalog(request);
  return {
    ...response,
    toolCalls: response.toolCalls.map((call) => {
      if (request.tools?.some((tool) => tool.function.name === call.name)) return call;
      const id = available.get(call.name);
      assert.ok(id, `tool search did not expose ${call.name}`);
      return {
        ...call,
        name: 'tool_call',
        arguments: JSON.stringify({ id, args: JSON.parse(call.arguments) }),
      };
    }),
  };
}

/** Run the same scenario through OpenClaw's advertised direct or Tool Search surface. */
export default function withToolSearch(scenario: OpenClawAIMockScenario): OpenClawAIMockScenario {
  const names = [...new Set(scenario.toolCalls.map((call) => call.name))];
  if (!names.length) return scenario;
  const needsDiscovery = (request: ChatCompletionRequest) =>
    controls(request) && !scenario.skipToolSearch?.(request);
  const discovery: Fixture = {
    match: {
      model: scenario.model.match,
      predicate: (request) => needsDiscovery(request) && !discoveryResult(request),
    },
    response: (request) => ({
      toolCalls: [
        {
          id: `${discoveryPrefix}${request.messages.filter((message) => message.role === 'user').length}`,
          name: 'tool_search',
          arguments: JSON.stringify({ queries: names.map((query) => ({ query, limit: 1 })) }),
        },
      ],
    }),
  };
  const adapted = new Map<Fixture, Fixture>();
  for (const fixture of scenario.fixtures) {
    const response = fixture.response;
    adapted.set(fixture, {
      ...fixture,
      match: {
        predicate: (request) =>
          (!needsDiscovery(request) || !!discoveryResult(request)) &&
          matchFixture(
            [fixture],
            normalizeToolSearchRequest(request, scenario.expectedDeniedToolCalls),
          ) !== null,
      },
      response:
        typeof response !== 'function' && !('toolCalls' in response)
          ? response
          : async (request) =>
              wrapResponse(
                request,
                typeof response === 'function'
                  ? await response(
                      normalizeToolSearchRequest(request, scenario.expectedDeniedToolCalls),
                    )
                  : response,
              ),
    });
  }
  return {
    ...scenario,
    toolSearchDiscoveryFixture: discovery,
    fixtures: [discovery, ...adapted.values()],
    dynamicFinalResponseFixtures: scenario.dynamicFinalResponseFixtures?.map((fixture) =>
      adapted.get(fixture)!,
    ),
  };
}
