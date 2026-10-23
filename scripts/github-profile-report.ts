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
  response?: GitHubRateLimit & { status: number };
  complete: boolean;
  requests: Array<{ route: string; durationMs?: number }>;
}

/** Aggregate private metadata only; quota deltas remain independent account-wide evidence. */
export function summarizeGitHubProfiles(profiles: Profile[]) {
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
    }
  >();
  const quotas = new Map<
    string,
    { account: string; resource: string; samples: number; minimum: number; maximum: number }
  >();
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
      };
      group.requests++;
      group.durationMs += request.durationMs ?? 0;
      groups.set(key, group);
    }
  }
  return {
    commands: profiles.length,
    incomplete: profiles.filter((profile) => !profile.complete).length,
    requests: [...groups.values()].reduce((sum, g) => sum + g.requests, 0),
    groups: [...groups.values()].sort((a, b) => b.requests - a.requests),
    quotas: [...quotas.values()],
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
  process.stdout.write('### GitHub request profile\n\n');
  process.stdout.write(
    `${summary.requests} HTTP requests across ${summary.commands} CLI invocations; ${summary.incomplete} incomplete traces.\n\n`,
  );
  process.stdout.write(
    '| Agent | Account label | Source | Operation | Route | Requests | Observed duration, ms |\n|---|---|---|---|---|---:|---:|\n',
  );
  for (const group of summary.groups)
    process.stdout.write(
      `| ${group.agent} | ${group.account} | ${group.source} | ${group.operation} | ${group.route} | ${group.requests} | ${group.durationMs.toFixed(1)} |\n`,
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
  process.stdout.write(
    '\nConcurrent requests retain counts; ambiguous per-route timings are omitted. Counts cover traced gh traffic, not Git transport or calls from other processes/accounts.\n',
  );
  if (summary.incomplete) process.exitCode = 1;
}
