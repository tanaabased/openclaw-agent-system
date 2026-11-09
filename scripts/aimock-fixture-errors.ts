import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

function resultDiagnostic(content: string): { status?: string; code?: string } {
  try {
    let value = JSON.parse(content);
    // Tool Search wraps the same plugin result delivered by a direct call.
    if (value?.tool?.source === 'openclaw' && Array.isArray(value.result?.content))
      value = JSON.parse(getTextContent(value.result.content) ?? '');
    const status = ['verified', 'material', 'blocked', 'failed', 'error', 'pending'].includes(
      value?.status,
    )
      ? value.status
      : undefined;
    const code =
      typeof value?.code === 'string' && /^[a-z]+(?:-[a-z]+)+$/u.test(value.code)
        ? value.code
        : undefined;
    return { ...(status ? { status } : {}), ...(code ? { code } : {}) };
  } catch {
    return {};
  }
}

/** AIMock does not journal predicate exceptions; retain their location without prompt data. */
export default function captureFixtureErrors(source: OpenClawAIMockScenario) {
  const errors: Array<{
    phase: string;
    name: string;
    frames: string[];
    toolResults: Array<{
      callId?: string;
      characters: number;
      truncated: boolean;
      status?: string;
      code?: string;
    }>;
  }> = [];
  const capture = (phase: string, request: ChatCompletionRequest, error: unknown) => {
    if (errors.length < 4)
      errors.push({
        phase,
        name: error instanceof Error ? error.name : 'UnknownError',
        frames:
          error instanceof Error
            ? (error.stack ?? '')
                .split('\n')
                .filter((line) => /^\s+at /u.test(line))
                .slice(0, 4)
            : [],
        toolResults: request.messages
          .filter((message) => message.role === 'tool')
          .slice(-3)
          .map((message) => {
            const content = getTextContent(message.content) ?? '';
            return {
              callId: message.tool_call_id,
              characters: content.length,
              truncated: /(?:tokens truncated|truncated dynamic tool result|\[truncated\])/u.test(
                content,
              ),
              ...resultDiagnostic(content),
            };
          }),
      });
    throw error;
  };
  const adapted = new Map<Fixture, Fixture>();
  for (const fixture of source.fixtures) {
    const predicate = fixture.match.predicate;
    const response = fixture.response;
    adapted.set(fixture, {
      ...fixture,
      match: {
        ...fixture.match,
        ...(predicate
          ? {
              predicate: (request: ChatCompletionRequest) => {
                try {
                  return predicate(request);
                } catch (error) {
                  return capture('match', request, error);
                }
              },
            }
          : {}),
      },
      response:
        typeof response === 'function'
          ? async (request) => {
              try {
                return await response(request);
              } catch (error) {
                return capture('response', request, error);
              }
            }
          : response,
    });
  }
  return {
    errors,
    scenario: {
      ...source,
      fixtures: [...adapted.values()],
      toolSearchDiscoveryFixture: source.toolSearchDiscoveryFixture
        ? adapted.get(source.toolSearchDiscoveryFixture)
        : undefined,
      dynamicFinalResponseFixtures: source.dynamicFinalResponseFixtures?.map((fixture) =>
        adapted.get(fixture)!,
      ),
    },
  };
}
