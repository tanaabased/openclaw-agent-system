import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { AgentSystemCliResult } from '../api/types.ts';
import retryGitHubRead from '../core/github-read-retry.ts';
import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';
import { formatProviderDiagnostic } from '../utils/provider-diagnostic.ts';

const repository = 'tanaabased/big-test-bucket';
type FixtureRequest =
  | { action: 'assign'; number: number }
  | { action: 'comment'; number: number; body: string; run: string }
  | { action: 'pulls'; branch: string };

function json(result: AgentSystemCliResult): unknown {
  if (result.exitCode !== 0 || result.timedOut || result.truncated) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reconcile an uncertain fixture write; never replay a comment whose receipt was lost. */
export default async function notificationFixtureGitHub(
  request: FixtureRequest,
  execute: (argv: string[], timeoutMs: number) => Promise<AgentSystemCliResult>,
  sleep: (ms: number) => Promise<unknown> = setTimeout,
): Promise<unknown> {
  const read = (argv: string[]) =>
    retryGitHubRead((timeoutMs) => execute(argv, timeoutMs), {
      sleep: async (ms) => {
        await sleep(ms);
      },
    });
  if (request.action === 'pulls') {
    assert.ok(request.branch && !request.branch.includes('\0'), 'fixture branch required');
    const result = await read([
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      request.branch,
      '--state',
      'open',
      '--json',
      'number',
    ]);
    const value = json(result);
    assert.ok(
      Array.isArray(value) && value.length <= 1,
      `fixture PR discovery failed: ${formatProviderDiagnostic(githubCliDiagnostic(result))}`,
    );
    assert.ok(
      value.every(
        (entry) => Number.isSafeInteger(object(entry)?.number) && Number(object(entry)?.number) > 0,
      ),
      'invalid fixture PR number',
    );
    return value;
  }
  assert.ok(
    Number.isSafeInteger(request.number) && request.number > 0,
    'positive fixture issue required',
  );
  const issue = `repos/${repository}/issues/${request.number}`;
  const marker =
    request.action === 'comment'
      ? `<!-- fixture:${request.run}:${createHash('sha256').update(request.body).digest('hex')} -->`
      : undefined;
  if (request.action === 'comment') {
    assert.match(request.run, /^\d+-\d+$/u, 'workflow run and attempt required');
    assert.ok(
      request.body.trim() && request.body.length <= 16_384,
      'bounded fixture comment required',
    );
  }
  const body = request.action === 'comment' ? `${request.body}\n\n${marker}` : undefined;
  const argv =
    request.action === 'assign'
      ? ['api', '--method', 'POST', `${issue}/assignees`, '-f', 'assignees[]=tanaabot']
      : ['api', '--method', 'POST', `${issue}/comments`, '-f', `body=${body}`];
  const matches = (value: unknown) => {
    const entry = object(value);
    if (!entry) return false;
    if (request.action === 'assign') {
      return (
        entry?.number === request.number &&
        Array.isArray(entry.assignees) &&
        entry.assignees.some((user) => object(user)?.login === 'tanaabot')
      );
    }
    return (
      entry?.body === body &&
      object(entry.user)?.login === 'emoriwan' &&
      typeof entry.node_id === 'string' &&
      Number.isSafeInteger(entry.id)
    );
  };
  const result = await execute(argv, 30_000);
  const value = json(result);
  if (matches(value)) return value;
  const diagnostic = githubCliDiagnostic(result);
  const evidence = `method=POST route=${issue}/${request.action === 'assign' ? 'assignees' : 'comments'} exitCode=${result.exitCode ?? 'none'} timedOut=${result.timedOut} truncated=${result.truncated} response=${/unexpected end of JSON input/iu.test(result.stderr) ? 'incomplete-json' : value === undefined ? 'unavailable-or-invalid' : 'unexpected-shape'} ${formatProviderDiagnostic(diagnostic)}`;
  // Denials are authoritative even if an earlier operation left matching state behind.
  if (['authentication', 'permission', 'rate-limit'].includes(diagnostic.classification)) {
    throw new Error(`fixture ${request.action} denied: ${evidence}`);
  }
  for (const delay of [0, 250, 1000]) {
    if (delay) await sleep(delay);
    const observed = await read(
      request.action === 'assign'
        ? ['api', issue]
        : ['api', `${issue}/comments?per_page=100`, '--paginate', '--slurp'],
    );
    const fresh = json(observed);
    if (fresh === undefined) {
      throw new Error(
        `fixture ${request.action} reconciliation read failed: ${formatProviderDiagnostic(githubCliDiagnostic(observed))}`,
      );
    }
    if (request.action === 'assign') {
      if (matches(fresh)) return fresh;
      assert.equal(object(fresh)?.number, request.number, 'invalid fixture issue readback');
    } else {
      assert.ok(
        Array.isArray(fresh) && fresh.every(Array.isArray),
        'invalid fixture comment pages',
      );
      const marked = fresh
        .flat()
        .filter(
          (entry) =>
            typeof object(entry)?.body === 'string' &&
            String(object(entry)?.body).includes(marker!),
        );
      assert.ok(
        marked.length <= 1 && marked.every(matches),
        'ambiguous or altered fixture comment; write not repeated',
      );
      if (marked.length === 1) return marked[0];
    }
  }
  throw new Error(`fixture ${request.action} outcome unresolved; POST not repeated: ${evidence}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { number: { type: 'string' }, body: { type: 'string' }, branch: { type: 'string' } },
  });
  const [action] = positionals;
  assert.ok(
    positionals.length === 1 && ['assign', 'comment', 'pulls'].includes(action ?? ''),
    'select assign, comment or pulls',
  );
  const request: FixtureRequest =
    action === 'pulls'
      ? { action, branch: values.branch ?? '' }
      : action === 'assign'
        ? { action, number: Number(values.number) }
        : {
            action: 'comment',
            number: Number(values.number),
            body: values.body ?? '',
            run: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
          };
  const value = await notificationFixtureGitHub(request, async (argv, timeoutMs) => {
    const result = spawnSync('openclaw', ['agent-system', 'tool', 'gh', '--', ...argv], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: code === 'ETIMEDOUT',
      truncated: code === 'ENOBUFS',
    };
  });
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
