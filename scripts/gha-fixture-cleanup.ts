#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { CliOutput } from '../cli/output.ts';

const project = 'tanaabased/openclaw-agent-system';
const bucket = 'tanaabased/big-test-bucket';
const workflows = ['os', 'codex', 'openclaw', 'notifications'].map(
  (name) => `.github/workflows/pr-examples-${name}.yml`,
);
type ObjectValue = Record<string, unknown>;
export type GhaFixtureApi = (
  method: 'GET' | 'PATCH' | 'DELETE' | 'POST',
  route: string,
  body?: ObjectValue,
) => Promise<unknown>;
export class GhaFixtureProviderError extends Error {
  constructor(readonly status: number) {
    super(`github-http-${status}`);
  }
}
function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'invalid-github-response');
  return value as ObjectValue;
}
export function fixturePrefix(repositoryId: number, runId: number, attempt: number) {
  assert.ok(
    [repositoryId, runId, attempt].every((value) => Number.isSafeInteger(value) && value > 0),
    'positive-source-identifiers-required',
  );
  return `agent-system-test-${repositoryId}-${runId}-${attempt}-`;
}

/** Re-read provider state on every invocation; no runner-local state is needed for retries. */
export default async function cleanupGhaFixtures(input: {
  runId: number;
  attempt: number;
  api: GhaFixtureApi;
  dryRun?: boolean;
}) {
  const { api, runId, attempt } = input;
  assert.ok(
    [runId, attempt].every((value) => Number.isSafeInteger(value) && value > 0),
    'positive-source-identifiers-required',
  );
  const run = object(
    await api('GET', `repos/${project}/actions/runs/${runId}/attempts/${attempt}`),
  );
  assert.ok(
    run.id === runId &&
      run.run_attempt === attempt &&
      run.status === 'completed' &&
      workflows.includes(String(run.path)) &&
      object(run.repository).full_name === project &&
      object(run.head_repository).id === object(run.repository).id &&
      typeof run.run_started_at === 'string' &&
      Number.isFinite(Date.parse(run.run_started_at)),
    'source-attempt-must-be-completed-and-owned',
  );
  const prefix = fixturePrefix(Number(object(run.repository).id), runId, attempt);
  assert.equal(object(await api('GET', 'user')).login, 'tanaabot', 'cleanup-account-mismatch');
  const outcomes: Array<{ resource: string; target: string; result: string }> = [];
  const done = (resource: string, target: string, result: string) =>
    outcomes.push({ resource, target, result });
  const attemptCleanup = async (resource: string, target: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      done(resource, target, error instanceof GhaFixtureProviderError ? error.message : 'failed');
    }
  };
  const list = async (route: string, before?: string) => {
    const result: ObjectValue[] = [];
    for (let page = 1; ; page++) {
      const values = await api(
        'GET',
        `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      assert.ok(Array.isArray(values), 'invalid-github-list');
      const entries = values.map(object);
      result.push(...entries);
      if (
        entries.length < 100 ||
        (before && entries.some((entry) => String(entry.created_at) < before))
      )
        return result;
    }
  };
  const remove = async (route: string) => {
    if (input.dryRun) return;
    try {
      await api('DELETE', route);
    } catch (error) {
      if (!(error instanceof GhaFixtureProviderError && error.status === 404)) throw error;
    }
  };

  for (const collection of ['keys', 'ssh_signing_keys']) {
    await attemptCleanup(collection, 'tanaabot', async () => {
      const keys = await list(`user/${collection}`);
      for (const key of keys.filter((key) => String(key.title).startsWith(prefix))) {
        await attemptCleanup(collection, String(key.id), async () => {
          assert.ok(Number.isSafeInteger(key.id), 'invalid-key-id');
          await remove(`user/${collection}/${key.id}`);
          done(collection, String(key.id), input.dryRun ? 'would-remove' : 'removed');
        });
      }
    });
  }

  let issues: ObjectValue[] = [];
  let defaultBranch = 'main';
  await attemptCleanup('issues', bucket, async () => {
    const repository = object(await api('GET', `repos/${bucket}`));
    assert.ok(
      repository.id === 1329940218 && repository.full_name === bucket,
      'cleanup-repository-mismatch',
    );
    assert.equal(typeof repository.default_branch, 'string', 'missing-default-branch');
    defaultBranch = String(repository.default_branch);
    issues = (
      await list(
        `repos/${bucket}/issues?state=all&since=${encodeURIComponent(String(run.run_started_at))}`,
      )
    ).filter(
      (issue) =>
        !issue.pull_request &&
        String(issue.title).startsWith(prefix) &&
        ['emoriwan', 'tanaabot'].includes(String(object(issue.user).login)),
    );
  });
  if (issues.length) {
    await attemptCleanup('pull-requests', bucket, async () => {
      const pulls = await list(
        `repos/${bucket}/pulls?state=all&sort=created&direction=desc`,
        String(run.run_started_at),
      );
      for (const pull of pulls) {
        const pullHead = object(pull.head);
        if (
          String(pull.created_at) < String(run.run_started_at) ||
          object(pull.user).login !== 'tanaabot' ||
          !pullHead.repo ||
          object(pullHead.repo).id !== 1329940218
        )
          continue;
        await attemptCleanup('pull-request', String(pull.number), async () => {
          const linked = object(
            await api('POST', 'graphql', {
              query:
                'query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:100){nodes{id} pageInfo{hasNextPage}}}}}',
              variables: { id: pull.node_id },
            }),
          );
          const references = object(object(object(linked.data).node).closingIssuesReferences);
          assert.ok(
            !object(references.pageInfo).hasNextPage && Array.isArray(references.nodes),
            'incomplete-closing-issues',
          );
          if (
            !references.nodes.some((node) =>
              issues.some((issue) => issue.node_id === object(node).id),
            )
          )
            return;
          if (pull.state !== 'closed' && !input.dryRun)
            await api('PATCH', `repos/${bucket}/pulls/${pull.number}`, {
              state: 'closed',
            });
          done(
            'pull-request',
            String(pull.number),
            pull.state !== 'closed' && input.dryRun ? 'would-close' : 'closed',
          );
          const head = object(pull.head);
          assert.ok(
            typeof head.ref === 'string' && ![defaultBranch, 'main', 'master'].includes(head.ref),
            'protected-branch',
          );
          await remove(`repos/${bucket}/git/refs/heads/${encodeURIComponent(head.ref)}`);
          done('branch', head.ref, input.dryRun ? 'would-remove' : 'removed');
        });
      }
    });
    for (const issue of issues) {
      await attemptCleanup('issue', String(issue.number), async () => {
        if (issue.state !== 'closed' && !input.dryRun)
          await api('PATCH', `repos/${bucket}/issues/${issue.number}`, {
            state: 'closed',
          });
        done(
          'issue',
          String(issue.number),
          issue.state !== 'closed' && input.dryRun ? 'would-close' : 'closed',
        );
      });
    }
  }
  return {
    runId,
    attempt,
    prefix,
    dryRun: input.dryRun ?? false,
    outcomes,
    ok: outcomes.every(({ result }) =>
      ['removed', 'closed', 'would-remove', 'would-close'].includes(result),
    ),
  };
}

export function ghaFixtureCleanupOptions(args: string[], environment: NodeJS.ProcessEnv) {
  let values;
  try {
    values = parseArgs({
      args,
      allowNegative: true,
      options: {
        'run-id': { type: 'string' },
        attempt: { type: 'string' },
        token: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }).values;
  } catch {
    throw new Error('invalid-arguments');
  }
  const boolean = (option: boolean | undefined, value: string | undefined) => {
    if (option !== undefined) return option;
    if (value === undefined) return false;
    assert.ok(['0', '1', 'false', 'true'].includes(value), 'invalid-boolean-default');
    return value === '1' || value === 'true';
  };
  return {
    runId: Number(values['run-id'] ?? environment.GHA_FIXTURE_CLEANUP_RUN_ID),
    attempt: Number(values.attempt ?? environment.GHA_FIXTURE_CLEANUP_ATTEMPT),
    token: values.token ?? (environment.GH_TOKEN || environment.GITHUB_TOKEN),
    dryRun: boolean(values['dry-run'], environment.GHA_FIXTURE_CLEANUP_DRY_RUN),
    json: boolean(values.json, environment.GHA_FIXTURE_CLEANUP_JSON),
    help: values.help,
    version: values.version,
  };
}

export function ghaFixtureApi(
  token: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): GhaFixtureApi {
  return async (method, route, body) => {
    const response = await request(`https://api.github.com/${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new GhaFixtureProviderError(response.status);
    const value: unknown = response.status === 204 ? null : await response.json();
    if (value && typeof value === 'object' && 'errors' in value)
      throw new Error('github-graphql-failed');
    return value;
  };
}

type CleanupReport = Awaited<ReturnType<typeof cleanupGhaFixtures>>;

/** CI uses dependency-free JSON; local human output reuses the product's presentation owner. */
export async function ghaFixtureCleanupCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: {
    api?: GhaFixtureApi;
    output?: CliOutput;
  } = {},
): Promise<number> {
  const output = dependencies.output ?? {
    writeStdout: (value: string) => process.stdout.write(value),
    writeStderr: (value: string) => process.stderr.write(value),
  };
  let json =
    args.includes('--json') || ['1', 'true'].includes(environment.GHA_FIXTURE_CLEANUP_JSON ?? '');
  let result: CleanupReport | { ok: false; code: string };
  try {
    const options = ghaFixtureCleanupOptions(args, environment);
    json = options.json;
    if (options.version) {
      const metadata = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      const SCRIPT_VERSION = metadata.version;
      output.writeStdout(`${SCRIPT_VERSION}\n`);
      return 0;
    }
    if (options.help) {
      const { createCliStyles } = await import('../cli/output.ts');
      const styles = createCliStyles(environment);
      output.writeStdout(
        `${styles.bold('usage')}
  ${styles.action('bun scripts/gha-fixture-cleanup.ts')} --run-id <id> --attempt <n> ${styles.field('[options]')}

${styles.bold('options')}
  --run-id <id>       completed source workflow run
  --attempt <n>       exact source attempt
  --token <token>     tanaabot user token
  --[no-]dry-run      preview without modifying resources
  --[no-]json         machine-readable result
  -h, --help         show help
  -v, --version      report package version

${styles.bold('environment variables')}
  GHA_FIXTURE_CLEANUP_RUN_ID     same as --run-id
  GHA_FIXTURE_CLEANUP_ATTEMPT    same as --attempt
  GHA_FIXTURE_CLEANUP_DRY_RUN    same as --dry-run (1/0 or true/false)
  GHA_FIXTURE_CLEANUP_JSON       same as --json (1/0 or true/false)
  GH_TOKEN, GITHUB_TOKEN        defaults for --token, in that order

explicit options override environment defaults. booleans default to false.
only tagged fixtures in ${bucket} and tanaabot's tagged keys are cleaned.
`,
      );
      return 0;
    }
    const token = options.token?.trim();
    assert.ok(token, 'cleanup-token-missing');
    const report = await cleanupGhaFixtures({
      runId: options.runId,
      attempt: options.attempt,
      dryRun: options.dryRun,
      api: dependencies.api ?? ghaFixtureApi(token),
    });
    if (environment.GITHUB_STEP_SUMMARY) {
      try {
        await appendFile(
          environment.GITHUB_STEP_SUMMARY,
          `### GHA fixture cleanup\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
        );
      } catch {
        report.outcomes.push({ resource: 'summary', target: 'github-actions', result: 'failed' });
        report.ok = false;
      }
    }
    result = report;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : '';
    const codes = [
      'invalid-arguments',
      'invalid-boolean-default',
      'cleanup-token-missing',
      'positive-source-identifiers-required',
      'source-attempt-must-be-completed-and-owned',
      'cleanup-account-mismatch',
      'invalid-github-response',
    ];
    result = {
      ok: false,
      code:
        error instanceof GhaFixtureProviderError
          ? `github-http-${error.status}`
          : codes.includes(message ?? '')
            ? message!
            : 'cleanup-failed',
    };
  }

  if (json) output.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const [{ createCliStyles, writeCliError }, { default: presentCliCommand }] = await Promise.all([
      import('../cli/output.ts'),
      import('../cli/presentation.ts'),
    ]);
    const styles = createCliStyles(environment);
    await presentCliCommand(async (options) => {
      if ('code' in result) {
        writeCliError(
          options.output,
          `${result.code}; run bun scripts/gha-fixture-cleanup.ts --help`,
        );
        return;
      }
      output.writeStdout(
        `\n${styles.action('cleanup')} ${styles.target(`run ${result.runId}, attempt ${result.attempt}`)} ${result.ok ? styles.status(result.dryRun ? 'preview' : 'complete') : styles.warning('partial')}\n`,
      );
      for (const item of result.outcomes)
        output.writeStdout(`${item.resource} ${styles.target(item.target)}: ${item.result}\n`);
      if (!result.outcomes.length) output.writeStdout('no matching fixtures\n');
      output.writeStdout('\n');
      if (!result.ok)
        writeCliError(
          options.output,
          'some fixtures remain; rerun cleanup for the same run and attempt',
        );
    })({ output, styles });
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await ghaFixtureCleanupCli(process.argv.slice(2), process.env);
}
