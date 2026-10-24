import AgentSystemToolError from '../../api/error.ts';
import type { AgentSystemCliResult } from '../../api/types.ts';
import { githubCliDiagnostic } from '../../credentials/github-diagnostic.ts';
import githubCredentialRejected from '../../credentials/github-rejection.ts';
import inspectAssignmentRequest, {
  selfUnassignmentMessage,
  type AssignmentEffect,
} from './assignment-request.ts';
import type { GitHubToolInput } from './tool-schema.ts';

type Run = (argv: string[], stdin?: string) => Promise<AgentSystemCliResult>;

function checked(result: AgentSystemCliResult): string {
  if (result.timedOut)
    throw new AgentSystemToolError('execution_timed_out', 'The GitHub assignment check timed out.');
  if (result.exitCode !== 0)
    throw new AgentSystemToolError(
      'execution_failed',
      'GitHub rejected the authenticated assignment check.',
      githubCredentialRejected(result),
      githubCliDiagnostic(result, 'identity-check'),
    );
  if (result.truncated)
    throw new AgentSystemToolError(
      'execution_failed',
      'GitHub returned an incomplete assignment check.',
    );
  return result.stdout;
}

function invalidCheck(): never {
  throw new AgentSystemToolError(
    'execution_failed',
    'GitHub returned an invalid assignment check. Verify the account and its read access, then retry.',
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCheck();
  return value as Record<string, unknown>;
}

function json(result: AgentSystemCliResult): Record<string, unknown> {
  const text = checked(result);
  try {
    return record(JSON.parse(text));
  } catch {
    return invalidCheck();
  }
}

function deny(): never {
  throw new AgentSystemToolError('approval_denied', selfUnassignmentMessage);
}

async function assignmentState(
  effect: AssignmentEffect,
  login: string,
  run: Run,
  requireCanonicalId: boolean,
): Promise<{ key: string; assigned: boolean }> {
  if (!effect.target) return invalidCheck();
  if ('rest' in effect.target) {
    const response = json(await run(['api', effect.target.rest]));
    if (!Array.isArray(response.assignees)) return invalidCheck();
    const assigned = response.assignees.some((value) => {
      const user = record(value);
      if (typeof user.login !== 'string' || !user.login) invalidCheck();
      return user.login.toLowerCase() === login.toLowerCase();
    });
    return { key: effect.target.rest, assigned };
  }
  const response = json(
    await run([
      'api',
      'graphql',
      '-f',
      'query=query($id:ID!){node(id:$id){id ... on Issue{assignees(first:100){nodes{login} pageInfo{hasNextPage}}} ... on PullRequest{assignees(first:100){nodes{login} pageInfo{hasNextPage}}}}}',
      '-f',
      `id=${effect.target.node}`,
    ]),
  );
  if (response.errors) return invalidCheck();
  const node = record(record(response.data).node);
  if (requireCanonicalId && (typeof node.id !== 'string' || !node.id)) invalidCheck();
  const assignees = record(node.assignees);
  if (record(assignees.pageInfo).hasNextPage !== false || !Array.isArray(assignees.nodes))
    return invalidCheck();
  const assigned = assignees.nodes.some((value) => {
    const user = record(value);
    if (typeof user.login !== 'string' || !user.login) invalidCheck();
    return user.login.toLowerCase() === login.toLowerCase();
  });
  return { key: typeof node.id === 'string' ? node.id : effect.target.node, assigned };
}

/** verify every protected effect before forwarding any part of a mutation. */
export default async function prepareGitHubAssignmentRequest(
  input: GitHubToolInput,
  username: string | undefined,
  scope: {
    cwd: string;
    run: Run;
    identity?: () => Promise<{ login: string; node_id: string }>;
    readInput?: (path: string, cwd: string, stdin?: string) => Promise<string>;
  },
): Promise<GitHubToolInput> {
  const { request, effects } = await inspectAssignmentRequest(input, scope.cwd, scope.readInput);
  if (!effects.length && !username) return request;
  if (!effects.length && !scope.identity) {
    if (username) {
      const actual = checked(await scope.run(['api', 'user', '--jq', '.login'])).trim();
      if (actual.toLowerCase() !== username.toLowerCase()) {
        throw new AgentSystemToolError(
          'tool_identity_mismatch',
          'GitHub returned an account that does not match the configured username.',
        );
      }
    }
    return request;
  }
  // Protected assignment changes need the current login, including provider-side renames.
  const user =
    !effects.length && scope.identity
      ? await scope.identity()
      : json(await scope.run(['api', 'user']));
  if (
    typeof user.login !== 'string' ||
    !user.login ||
    typeof user.node_id !== 'string' ||
    !user.node_id
  )
    invalidCheck();
  if (username && user.login.toLowerCase() !== username.toLowerCase()) {
    throw new AgentSystemToolError(
      'tool_identity_mismatch',
      'GitHub returned an account that does not match the configured username.',
    );
  }
  if (!effects.length) return request;
  // legacy and next-generation node ids can identify the same GitHub user.
  const nodeIds = [
    ...new Set(
      effects
        .filter((effect) => effect.identity === 'node')
        .flatMap((effect) => effect.members)
        .filter((id) => id !== user.node_id),
    ),
  ];
  const selfNodeIds = new Set([user.node_id]);
  if (nodeIds.length) {
    const response = json(
      await scope.run(
        ['api', 'graphql', '--input', '-'],
        JSON.stringify({
          query: 'query($ids:[ID!]!){nodes(ids:$ids){... on User{login}}}',
          variables: { ids: nodeIds },
        }),
      ),
    );
    if (response.errors) invalidCheck();
    const nodes = record(response.data).nodes;
    if (!Array.isArray(nodes) || nodes.length !== nodeIds.length) invalidCheck();
    for (const [index, value] of nodes.entries()) {
      const resolved = record(value);
      if (typeof resolved.login !== 'string' || !resolved.login) invalidCheck();
      if (resolved.login.toLowerCase() === user.login.toLowerCase())
        selfNodeIds.add(nodeIds[index] as string);
    }
  }
  const predictedAssignments = new Map<string, boolean>();
  for (const effect of effects) {
    const containsSelf = effect.members.some((member) =>
      effect.identity === 'node'
        ? selfNodeIds.has(member)
        : member.trim() === '@me' ||
          member.trim().toLowerCase() === (user.login as string).toLowerCase(),
    );
    if (effect.mode === 'remove' && containsSelf) deny();
    if (effect.mode === 'remove' || (effect.mode === 'add' && !containsSelf)) continue;
    if (containsSelf && effects.length === 1) continue;
    const state = await assignmentState(effect, user.login, scope.run, effects.length > 1);
    const assigned = predictedAssignments.get(state.key) ?? state.assigned;
    if (effect.mode === 'replace' && !containsSelf && assigned) deny();
    predictedAssignments.set(state.key, containsSelf || (effect.mode === 'add' && assigned));
  }
  return request;
}
