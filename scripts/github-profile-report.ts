import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GitHubRateLimit } from '../channels/github/provider/api-response.ts';

interface Profile {
  version: number;
  agentId?: string;
  account?: string;
  source?: string;
  operation?: string;
  exitCode?: number | null;
  response?: GitHubRateLimit & { status: number };
  complete: boolean;
  requests: Array<{ route: string; durationMs?: number }>;
}

/** Aggregate private metadata only; quota deltas remain independent account-wide evidence. */
export function summarizeGitHubProfiles(profiles: Profile[]) {
  const emptyUsage = () => ({
    restNon304: 0,
    notModified: 0,
    graphql: 0,
    rateLimit: 0,
    unclassified: 0,
  });
  const usage = emptyUsage();
  const resources = new Map<
    string,
    ReturnType<typeof emptyUsage> & { account: string; resource: string }
  >();
  const groups = new Map<
    string,
    {
      agent: string;
      account: string;
      source: string;
      operation: string;
      route: string;
      requests: number;
      durationMs: number;
      restNon304: number;
      notModified: number;
      graphql: number;
      rateLimit: number;
      unclassified: number;
    }
  >();
  const quotas = new Map<
    string,
    { account: string; resource: string; samples: number; minimum: number; maximum: number }
  >();
  const failures = profiles.filter(
    (profile) =>
      profile.exitCode !== undefined &&
      profile.exitCode !== 0 &&
      !(profile.complete && profile.requests.length === 1 && profile.response?.status === 304),
  );
  for (const profile of profiles) {
    if (profile.version !== 1 || !Array.isArray(profile.requests))
      throw new Error('unsupported github profile');
    const quota = profile.response;
    if (quota?.resource && quota.remaining !== undefined) {
      const key = JSON.stringify([profile.account, quota.resource]);
      const group = quotas.get(key) ?? {
        account: profile.account ?? 'unattributed',
        resource: quota.resource,
        samples: 0,
        minimum: quota.remaining,
        maximum: quota.remaining,
      };
      group.samples++;
      group.minimum = Math.min(group.minimum, quota.remaining);
      group.maximum = Math.max(group.maximum, quota.remaining);
      quotas.set(key, group);
    }
    for (const request of profile.requests) {
      // a command's final response cannot classify several (possibly overlapping) requests.
      const response =
        profile.complete && profile.requests.length === 1 ? profile.response : undefined;
      const category =
        request.route === '/rate_limit'
          ? 'rateLimit'
          : request.route === '/graphql'
            ? 'graphql'
            : response?.status === 304
              ? 'notModified'
              : response &&
                  response.status !== 304 &&
                  response.resource &&
                  response.resource !== 'graphql'
                ? 'restNon304'
                : 'unclassified';
      const resource =
        request.route === '/graphql' ? 'graphql' : (response?.resource ?? 'unclassified');
      const resourceKey = JSON.stringify([profile.account, resource]);
      const resourceUsage = resources.get(resourceKey) ?? {
        account: profile.account ?? 'unattributed',
        resource,
        ...emptyUsage(),
      };
      resourceUsage[category]++;
      usage[category]++;
      resources.set(resourceKey, resourceUsage);
      const key = JSON.stringify([
        profile.agentId,
        profile.account,
        profile.source,
        profile.operation,
        request.route,
      ]);
      const group = groups.get(key) ?? {
        agent: profile.agentId ?? 'unattributed',
        account: profile.account ?? 'unattributed',
        source: profile.source ?? 'unattributed',
        operation: profile.operation ?? 'unattributed',
        route: request.route,
        requests: 0,
        durationMs: 0,
        ...emptyUsage(),
      };
      group.requests++;
      group[category]++;
      group.durationMs += request.durationMs ?? 0;
      groups.set(key, group);
    }
  }
  return {
    commands: profiles.length,
    incomplete: profiles.filter((profile) => !profile.complete).length,
    ...usage,
    resources: [...resources.values()],
    requests: [...groups.values()].reduce((sum, g) => sum + g.requests, 0),
    groups: [...groups.values()].sort(
      (a, b) => b.restNon304 - a.restNon304 || b.requests - a.requests,
    ),
    quotas: [...quotas.values()],
    failures: failures.map(
      ({ agentId, account, source, operation, exitCode, response, requests }) => ({
        agent: agentId ?? 'unattributed',
        account: account ?? 'unattributed',
        source: source ?? 'unattributed',
        operation: operation ?? 'unattributed',
        exitCode,
        httpStatus: response?.status,
        requests: requests.length,
      }),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('a github profile directory is required');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  if (!names.length) throw new Error('no github profiles were captured');
  const summary = summarizeGitHubProfiles(
    await Promise.all(
      names.map(
        async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as Profile,
      ),
    ),
  );
  process.stdout.write('### GitHub primary-quota profile\n\n');
  process.stdout.write(
    `${summary.restNon304} REST non-304 responses (quota proxy); ${summary.notModified} HTTP 304s; ${summary.graphql} GraphQL requests; ${summary.rateLimit} rate-limit checks; ${summary.unclassified} unclassified requests.\n\n`,
  );
  process.stdout.write(
    'The REST proxy counts observed non-304 responses with a quota resource; it is not an exact charge. Authenticated 304s and rate-limit checks are primary-exempt. GraphQL requests are not GraphQL points. Unknown or multi-request response associations remain unclassified.\n\n',
  );
  process.stdout.write(
    '| Account | Resource | REST non-304 proxy | 304 | GraphQL requests | Rate-limit checks | Unclassified |\n|---|---|---:|---:|---:|---:|---:|\n',
  );
  for (const resource of summary.resources)
    process.stdout.write(
      `| ${resource.account} | ${resource.resource} | ${resource.restNon304} | ${resource.notModified} | ${resource.graphql} | ${resource.rateLimit} | ${resource.unclassified} |\n`,
    );
  process.stdout.write('\n');
  process.stdout.write(
    `${summary.requests} HTTP requests across ${summary.commands} CLI invocations; ${summary.incomplete} incomplete traces.\n\n`,
  );
  if (summary.notModified)
    process.stdout.write(
      `${summary.notModified} HTTP 304 responses (included in HTTP counts).\n\n`,
    );
  process.stdout.write(
    '| Agent | Account label | Source | Operation | Route | REST non-304 proxy | 304 | Unclassified | HTTP requests | Observed duration, ms |\n|---|---|---|---|---|---:|---:|---:|---:|---:|\n',
  );
  for (const group of summary.groups)
    process.stdout.write(
      `| ${group.agent} | ${group.account} | ${group.source} | ${group.operation} | ${group.route} | ${group.restNon304} | ${group.notModified} | ${group.unclassified} | ${group.requests} | ${group.durationMs.toFixed(1)} |\n`,
    );
  if (summary.quotas.length) {
    process.stdout.write(
      '\nAvailable response quota counters (not consumption deltas):\n\n| Account | Resource | Samples | Minimum remaining | Maximum remaining |\n|---|---|---:|---:|---:|\n',
    );
    for (const quota of summary.quotas)
      process.stdout.write(
        `| ${quota.account} | ${quota.resource} | ${quota.samples} | ${quota.minimum} | ${quota.maximum} |\n`,
      );
  }
  if (summary.failures.length) {
    process.stdout.write(
      '\nNonzero or unavailable command exits, excluding HTTP 304 (not necessarily provider denials):\n\n| Agent | Account label | Source | Operation | Exit code | HTTP status | Requests |\n|---|---|---|---|---:|---:|---:|\n',
    );
    for (const failure of summary.failures)
      process.stdout.write(
        `| ${failure.agent} | ${failure.account} | ${failure.source} | ${failure.operation} | ${failure.exitCode ?? 'unavailable'} | ${failure.httpStatus ?? 'unobserved'} | ${failure.requests} |\n`,
      );
  }
  process.stdout.write(
    '\nConcurrent requests retain counts; ambiguous per-route timings are omitted. Counts cover traced gh traffic, not Git transport or calls from other processes/accounts.\n',
  );
  if (summary.incomplete)
    process.stdout.write(
      '\nIncomplete traces prevent an exact request total; reported counts include only observed traffic. Profiling does not change the scenario outcome.\n',
    );
}
