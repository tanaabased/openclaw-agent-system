import assert from 'node:assert/strict';

import AgentSystemToolError from '../api/error.ts';
import type { AgentSystemCliResult } from '../api/types.ts';
import prepareGitHubAssignmentRequest from '../tools/github/assignment-guard.ts';
import inspectAssignmentRequest, {
  cliAssignmentRemovals,
} from '../tools/github/assignment-request.ts';
import type { GitHubToolInput } from '../tools/github/tool-schema.ts';

const target = 'repos/owner/repo/issues/12';
const identity = { login: 'tanaabot', node_id: 'SELF' };
const result = (
  value: unknown,
  overrides: Partial<AgentSystemCliResult> = {},
): AgentSystemCliResult => ({
  exitCode: 0,
  stderr: '',
  stdout: JSON.stringify(value),
  timedOut: false,
  truncated: false,
  ...overrides,
});
const api = (argv: string[], payload?: unknown): GitHubToolInput => ({
  argv: ['api', ...argv, ...(payload === undefined ? [] : ['--input', '-'])],
  ...(payload === undefined ? {} : { stdin: JSON.stringify(payload) }),
});
const graphql = (query: string, variables?: unknown, operationName?: string) =>
  api(['graphql'], { query, variables, operationName });

function scope(
  options: {
    assigned?: boolean;
    nodeLogin?: string;
    response?: AgentSystemCliResult;
    membership?: AgentSystemCliResult;
    readInput?: (path: string, cwd: string, stdin?: string) => Promise<string>;
  } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    cwd: '/workspace',
    readInput: options.readInput,
    async run(argv: string[]) {
      calls.push(argv);
      if (argv[1] === 'user') return options.response ?? result(identity);
      if (argv[1] === 'graphql' && argv.includes('--input'))
        return result({ data: { nodes: [{ login: options.nodeLogin ?? 'other' }] } });
      return (
        options.membership ??
        (argv[1] === 'graphql'
          ? result({
              data: {
                node: {
                  id: 'CANONICAL_ISSUE',
                  assignees: {
                    nodes: options.assigned ? [{ login: 'Tanaabot' }] : [],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            })
          : result({ assignees: options.assigned ? [{ login: 'Tanaabot' }] : [] }))
      );
    },
  };
}
const selfDenied = (error: unknown) =>
  error instanceof AgentSystemToolError &&
  error.code === 'approval_denied' &&
  /self-unassignment/u.test(error.message);
const invalid = (error: unknown) =>
  error instanceof AgentSystemToolError && error.code === 'invalid_arguments';

describe('tools/github/assignment-request', () => {
  for (const argv of [
    ['issue', 'edit', '12', '--remove-assignee', 'other,TANAABOT'],
    ['issue', 'edit', '12', '--remove-assignee', '"tanaabot"'],
    ['issue', 'edit', '12', '--remove-assignee', 'other,  tanaabot'],
    ['--repo=owner/repo', 'pr', 'edit', '--remove-assignee=other', '12', '--remove-assignee=@me'],
    ['issue', '-Rowner/repo', 'edit', '12', '13', '--remove-assignee', 'tanaabot'],
  ]) {
    it('should parse repeated and comma-separated removal options', () => {
      assert.ok(
        cliAssignmentRemovals({ argv }).some((effect) =>
          effect.members.some((member) => ['@me', 'TANAABOT', 'tanaabot'].includes(member)),
        ),
      );
    });
  }
  for (const argv of [
    ['issue', 'edit', '12', '--body', '--remove-assignee', '--title', '@me'],
    ['issue', 'edit', '12', '--body', '--help', '--add-assignee', 'other'],
    ['pr', 'edit', '12', '--help', '--remove-assignee', '@me'],
    ['issue', 'view', '12', '--remove-assignee=@me'],
  ]) {
    it('should not interpret option values or help as assignment changes', () => {
      assert.deepEqual(cliAssignmentRemovals({ argv }), []);
    });
  }
  for (const input of [
    api([`${target}/assignees`, '-XDELETE', '-f', 'assignees[]=TANAABOT']),
    api([`${target}/assignees`, '-iXDELETE', '-fassignees[]=TANAABOT']),
    api([
      '--method=DELETE',
      `https://api.github.com/${target}/assignees/`,
      '--raw-field=assignees[]=tanaabot',
    ]),
    api([`${target}/assignees`, '--method', 'DELETE', '-Fassignees[]=tanaabot']),
    api([`${target}/assignees`, '-X', 'DELETE'], { assignees: ['tanaabot'] }),
    api(['repos/owner/repo/issues/%31%32/assignees', '-XDELETE'], { assignees: ['tanaabot'] }),
  ]) {
    it('should reject supported rest removal spellings', async () => {
      const execution = scope();
      await assert.rejects(prepareGitHubAssignmentRequest(input, undefined, execution), selfDenied);
      assert.equal(execution.calls.length, 1);
    });
  }
  for (const payload of [
    { assignees: [] },
    { assignee: null },
    { assignee: '' },
    { assignees: ['other'] },
  ]) {
    it('should reject replacement only when it removes an existing self-assignment', async () => {
      const input = api([target, '-XPATCH'], payload);
      await assert.rejects(
        prepareGitHubAssignmentRequest(input, undefined, scope({ assigned: true })),
        selfDenied,
      );
      assert.deepEqual(await prepareGitHubAssignmentRequest(input, undefined, scope()), input);
    });
  }
  for (const input of [
    api([target, '-XPATCH', '-Fassignees[]']),
    api([target, '-XPATCH', '-Fassignee=null']),
  ]) {
    it('should inspect typed null and empty field arrays as clearing', async () => {
      await assert.rejects(
        prepareGitHubAssignmentRequest(input, undefined, scope({ assigned: true })),
        selfDenied,
      );
    });
  }
  for (const input of [
    api([target, '-XPATCH'], { body: 'removeAssigneesFromAssignable assignees @me' }),
    api([`${target}/assignees`, '-XPOST'], { assignees: ['other'] }),
    api([target, '-XGET'], { assignees: [] }),
    api(['repos/owner/repo/labels', '-XDELETE'], { assignees: ['tanaabot'] }),
  ]) {
    it('should leave reads, additive assignment and unrelated requests available', async () => {
      const execution = scope();
      assert.deepEqual(await prepareGitHubAssignmentRequest(input, undefined, execution), input);
      assert.deepEqual(execution.calls, []);
    });
  }
  it('should allow other removals and self-retaining replacements without membership reads', async () => {
    for (const input of [
      api([`${target}/assignees`, '-XDELETE'], { assignees: ['other'] }),
      api([target, '-XPATCH'], { assignees: ['TANAABOT', 'other'] }),
      { argv: ['issue', 'edit', '12', '--remove-assignee', 'other'] },
    ]) {
      const execution = scope();
      assert.deepEqual(await prepareGitHubAssignmentRequest(input, undefined, execution), input);
      assert.equal(execution.calls.length, 1);
    }
  });
  it('should inspect and forward one snapshot of file-backed json', async () => {
    let reads = 0;
    const execution = scope({
      readInput: async () => {
        reads += 1;
        return '{"assignees":["tanaabot"]}';
      },
    });
    const prepared = await prepareGitHubAssignmentRequest(
      { argv: ['api', target, '-XPATCH', '--input=payload.json'] },
      undefined,
      execution,
    );
    assert.equal(reads, 1);
    assert.deepEqual(prepared, {
      argv: ['api', target, '-XPATCH', '--input', '-'],
      stdin: '{"assignees":["tanaabot"]}',
    });
  });
  it('should inspect and freeze typed file fields, not raw literal at-signs', async () => {
    let reads = 0;
    const execution = scope({
      readInput: async () => {
        reads += 1;
        return 'other';
      },
    });
    const prepared = await prepareGitHubAssignmentRequest(
      { argv: ['api', `${target}/assignees`, '-XDELETE', '-F', 'assignees[]=@login.txt'] },
      undefined,
      execution,
    );
    assert.deepEqual(prepared.argv.slice(-2), ['--raw-field', 'assignees[]=other']);
    await prepareGitHubAssignmentRequest(
      { argv: ['api', `${target}/assignees`, '-XDELETE', '-f', 'assignees[]=@literal'] },
      undefined,
      execution,
    );
    assert.equal(reads, 1);
  });
  for (const input of [
    api([target, '-XPATCH', '-F', 'assignee={owner}']),
    api([target, '-XPATCH', '-f', 'assignee=other', '-f', 'assignee=tanaabot']),
    api([target, '-XPATCH', '-f', 'assignees=other', '-f', 'assignees[]=tanaabot']),
    api([`${target}?assignee=other`, '-XPATCH'], { assignees: [] }),
    api([target, '-XPATCH', '-f', 'assignee=other'], { assignees: [] }),
    api([target, '-XPATCH'], { assignees: false }),
  ]) {
    it('should reject ambiguous protected payloads before authenticated reads', async () => {
      const execution = scope();
      await assert.rejects(prepareGitHubAssignmentRequest(input, undefined, execution), invalid);
      assert.deepEqual(execution.calls, []);
    });
  }
});

describe('tools/github/assignment-graphql', () => {
  for (const input of [
    graphql(
      'mutation { renamed:removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:["SELF"]}) { clientMutationId } }',
    ),
    graphql(
      'mutation Remove($input:RemoveAssigneesFromAssignableInput!){ removeAssigneesFromAssignable(input:$input){clientMutationId} }',
      { input: { assignableId: 'ISSUE', assigneeIds: ['SELF'] } },
    ),
    graphql(
      'mutation Remove($id:ID!="SELF"){ ...Root } fragment Root on Mutation { ... on Mutation { removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:[$id]}){clientMutationId} } }',
    ),
    api([
      'graphql',
      '-f',
      'query=mutation($input:RemoveAssigneesFromAssignableInput!){removeAssigneesFromAssignable(input:$input){clientMutationId}}',
      '-f',
      'input[assignableId]=ISSUE',
      '-f',
      'input[assigneeIds][]=SELF',
    ]),
  ]) {
    it('should reject node-id removal through inline inputs, variables, defaults and fragments', async () => {
      await assert.rejects(prepareGitHubAssignmentRequest(input, undefined, scope()), selfDenied);
    });
  }
  for (const query of [
    'mutation{updateIssue(input:{id:"ISSUE",assigneeIds:[]}){clientMutationId}}',
    'mutation{updatePullRequest(input:{pullRequestId:"PR",assigneeIds:["OTHER"]}){clientMutationId}}',
  ]) {
    it('should check complete node assignment state for replacements', async () => {
      const input = graphql(query);
      await assert.rejects(
        prepareGitHubAssignmentRequest(input, undefined, scope({ assigned: true })),
        selfDenied,
      );
      assert.deepEqual(await prepareGitHubAssignmentRequest(input, undefined, scope()), input);
    });
  }
  it('should preserve an operation whose protected field is explicitly skipped', async () => {
    const input = graphql(
      'mutation($skip:Boolean! = true){removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:["SELF"]}) @skip(if:$skip){clientMutationId}}',
    );
    const execution = scope();
    await prepareGitHubAssignmentRequest(input, undefined, execution);
    assert.deepEqual(execution.calls, []);
  });
  it('should resolve alternate node ids to authenticated login before allowing removal', async () => {
    const request = graphql(
      'mutation{removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:["ALTERNATE_SELF"]}){clientMutationId}}',
    );
    await assert.rejects(
      prepareGitHubAssignmentRequest(request, undefined, scope({ nodeLogin: 'TANAABOT' })),
      selfDenied,
    );
    await prepareGitHubAssignmentRequest(request, undefined, scope({ nodeLogin: 'other' }));
  });
  it('should select the requested operation rather than inspecting unselected mutations', async () => {
    const input = graphql(
      'query Read{viewer{login}} mutation Remove{removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:["SELF"]}){clientMutationId}}',
      {},
      'Read',
    );
    const execution = scope();
    assert.deepEqual(await prepareGitHubAssignmentRequest(input, undefined, execution), input);
    assert.deepEqual(execution.calls, []);
  });
  for (const query of [
    'query{viewer{login}}',
    'mutation{addAssigneesToAssignable(input:{assignableId:"ISSUE",assigneeIds:["SELF"]}){clientMutationId}}',
    'mutation{updateIssue(input:{id:"ISSUE",body:"removeAssigneesFromAssignable assigneeIds"}){clientMutationId}}',
  ]) {
    it('should preserve queries, additions and unrelated mutation inputs', async () => {
      const execution = scope();
      await prepareGitHubAssignmentRequest(graphql(query), undefined, execution);
      assert.deepEqual(execution.calls, []);
    });
  }
  for (const input of [
    graphql('mutation($missing:UpdateIssueInput!){updateIssue(input:$missing){clientMutationId}}'),
    graphql(
      'mutation{updateIssue(input:{id:"ISSUE",assigneeIds:[],assigneeIds:["SELF"]}){clientMutationId}}',
    ),
    graphql('mutation{...Root} fragment Root on Mutation{...Root}'),
    graphql(
      'mutation First{updateIssue(input:{id:"ISSUE",assigneeIds:[]}){clientMutationId}} mutation Second{updateIssue(input:{id:"ISSUE",assigneeIds:["SELF"]}){clientMutationId}}',
    ),
  ]) {
    it('should not forward unresolved or ambiguous mutation inputs', async () => {
      await assert.rejects(inspectAssignmentRequest(input, '/workspace'), invalid);
    });
  }
  it('should reject self-removal introduced by an earlier mutation in the same request', async () => {
    for (const first of [
      'updateIssue(input:{id:"FIRST_ALIAS",assigneeIds:["SELF"]})',
      'addAssigneesToAssignable(input:{assignableId:"FIRST_ALIAS",assigneeIds:["SELF"]})',
    ]) {
      const input = graphql(
        `mutation{first:${first}{clientMutationId} second:updateIssue(input:{id:"SECOND_ALIAS",assigneeIds:[]}){clientMutationId}}`,
      );
      await assert.rejects(prepareGitHubAssignmentRequest(input, undefined, scope()), selfDenied);
    }
  });
  it('should validate every mutation before executing a mixed request', async () => {
    const input = graphql(
      'mutation{first:updateIssue(input:{id:"UNASSIGNED",assigneeIds:[]}){clientMutationId} second:removeAssigneesFromAssignable(input:{assignableId:"ISSUE",assigneeIds:["SELF"]}){clientMutationId}}',
    );
    const execution = scope();
    await assert.rejects(prepareGitHubAssignmentRequest(input, undefined, execution), selfDenied);
    assert.equal(execution.calls.length, 2);
    assert.ok(execution.calls[1]?.includes('id=UNASSIGNED'));
  });
});

describe('tools/github/assignment-guard', () => {
  const input = api([target, '-XPATCH'], { assignees: [] });
  for (const response of [
    result(identity, { exitCode: 1, stderr: 'provider denied' }),
    result(identity, { truncated: true }),
    result(identity, { timedOut: true }),
    result({ login: 'tanaabot' }),
    result({ login: '', node_id: 'SELF' }),
    result(null),
  ]) {
    it('should stop without mutation when authenticated identity cannot be verified', async () => {
      const execution = scope({ response });
      await assert.rejects(
        prepareGitHubAssignmentRequest(input, undefined, execution),
        AgentSystemToolError,
      );
      assert.equal(execution.calls.length, 1);
    });
  }
  for (const membership of [
    result({}, { exitCode: 1 }),
    result({ assignees: [] }, { truncated: true }),
    result({ assignees: [{}] }),
    result({ data: { node: { assignees: { nodes: [], pageInfo: { hasNextPage: true } } } } }),
    result({ data: { node: null }, errors: [{ message: 'denied' }] }),
  ]) {
    it('should stop when current replacement membership is unavailable or incomplete', async () => {
      for (const request of [
        input,
        graphql('mutation{updateIssue(input:{id:"ISSUE",assigneeIds:[]}){clientMutationId}}'),
      ]) {
        await assert.rejects(
          prepareGitHubAssignmentRequest(request, undefined, scope({ membership })),
          AgentSystemToolError,
        );
      }
    });
  }
  it('should compare the authenticated account against configured identity', async () => {
    await assert.rejects(
      prepareGitHubAssignmentRequest(input, 'other', scope()),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_identity_mismatch',
    );
  });
});
