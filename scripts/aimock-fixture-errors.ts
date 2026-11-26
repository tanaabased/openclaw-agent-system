import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';
import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

/** A dispatcher rejection has no inner result. Keep only known failure classes. */
function dispatchErrorCode(value: { status?: unknown; tool?: unknown; error?: unknown } | null) {
  if (
    value?.status !== 'error' ||
    !['dispatch_action', 'tool_call'].includes(String(value.tool)) ||
    typeof value.error !== 'string'
  )
    return;
  const known = value.error.match(
    /\b(?:material-native-response-unavailable|material-native-history-invalid|material-model-request-invalid|issue-pickup-tool-call-authorization-missing|intake-request-invalid|automation-lifecycle-unverified|automation-authority-unavailable|tool-call-id-mismatch)\b/u,
  );
  if (known) return known[0];
  if (value.error.includes('Invalid arguments for tool')) return 'invalid-tool-arguments';
  if (value.error.includes('Unknown tool id')) return 'unknown-tool-id';
  if (value.error.includes('blocked before execution')) return 'blocked-before-execution';
  if (value.error.includes('Denied by user')) return 'tool-call-denied';
  return 'unclassified-dispatch-error';
}

function resultDiagnostic(content: string): {
  exitCode?: number;
  httpStatus?: number;
  status?: string;
  code?: string;
  providerDiagnostic?: ProviderDiagnostic;
} {
  try {
    let value = JSON.parse(content);
    // Tool Search wraps the same plugin result delivered by a direct call.
    if (value?.tool?.source === 'openclaw' && Array.isArray(value.result?.content))
      value = JSON.parse(getTextContent(value.result.content) ?? '');
    const status = [
      'verified',
      'material',
      'blocked',
      'uncertain',
      'failed',
      'error',
      'pending',
    ].includes(value?.status)
      ? value.status
      : undefined;
    const code =
      typeof value?.code === 'string' && /^[a-z]+(?:-[a-z]+)+$/u.test(value.code)
        ? value.code
        : dispatchErrorCode(value);
    const exitCode = Number.isSafeInteger(value?.exitCode) ? value.exitCode : undefined;
    const httpStatus =
      exitCode && typeof value.stdout === 'string' && typeof value.stderr === 'string'
        ? githubCliDiagnostic(value).httpStatus
        : undefined;
    return {
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(httpStatus ? { httpStatus } : {}),
      ...(status ? { status } : {}),
      ...(code ? { code } : {}),
      ...(value?.providerDiagnostic?.provider === 'github'
        ? {
            providerDiagnostic: providerDiagnostic(
              'github',
              value.providerDiagnostic.operation,
              value.providerDiagnostic.classification,
              value.providerDiagnostic,
            ),
          }
        : {}),
    };
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
      exitCode?: number;
      httpStatus?: number;
      status?: string;
      code?: string;
      providerDiagnostic?: ProviderDiagnostic;
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
