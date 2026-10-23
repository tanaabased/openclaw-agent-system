import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import PrivateStateFile from './private-state-file.ts';

export interface GitHubProfileContext {
  agentId?: string;
  account?: string;
  source?: string;
}

export interface GitHubProfileRequest {
  route: string;
  durationMs?: number;
}

const routeWords = new Set([
  'assignees',
  'branches',
  'comments',
  'commits',
  'compare',
  'events',
  'git',
  'heads',
  'issues',
  'keys',
  'notifications',
  'pulls',
  'refs',
  'releases',
  'requested_reviewers',
  'reviews',
  'ssh_signing_keys',
  'timeline',
]);

function routeTemplate(target: string): string {
  let path;
  try {
    path = new URL(target).pathname;
  } catch {
    return '/:other';
  }
  const segments = path.split('/').filter(Boolean);
  const root = segments[0];
  if (root === 'graphql') return '/graphql';
  if (
    !['repos', 'orgs', 'users', 'user', 'search', 'notifications', 'rate_limit'].includes(
      root ?? '',
    )
  )
    return '/:other';
  return (
    '/' +
    segments
      .map((part, index) => {
        if (index === 0) return root;
        if (root === 'repos' && index <= 2) return index === 1 ? ':owner' : ':repo';
        if ((root === 'orgs' || root === 'users') && index === 1) return ':account';
        return routeWords.has(part) ? part : ':value';
      })
      .join('/')
  );
}

/** Observe gh's body-free debug mode; never enable its api payload logging. */
export default function createGitHubRequestProfile(maximumBytes: number) {
  const requests: GitHubProfileRequest[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let truncated = false;
  let complete = true;
  let inFlight = 0;
  let overlapping = false;
  let pending = '';
  let oversized = false;

  function capture(chunk: Buffer, stream: 'stdout' | 'stderr') {
    const available = Math.max(0, maximumBytes - bytes);
    const kept = chunk.subarray(0, available);
    if (kept.byteLength) (stream === 'stdout' ? stdout : stderr).push(kept);
    bytes += kept.byteLength;
    truncated ||= chunk.byteLength > available;
  }

  function line(value: string) {
    const request = value.match(/^\* Request to (\S+)\s*$/);
    if (request) {
      overlapping ||= inFlight > 0;
      inFlight++;
      if (requests.length < 10000) requests.push({ route: routeTemplate(request[1]!) });
      else complete = false;
      return;
    }
    const end = value.match(/^\* Request took ([\d.]+)(ms|s|µs|us|ns)\s*$/);
    if (end) {
      if (!inFlight) complete = false;
      else inFlight--;
      const active = requests.at(-1);
      if (active && !overlapping)
        active.durationMs =
          Number(end[1]) * ({ ms: 1, s: 1000, µs: 0.001, us: 0.001, ns: 0.000001 }[end[2]!] ?? 1);
      return;
    }
    if (value.startsWith('* ') || /^\[(?:git|gh)(?:\s|\])/.test(value)) return;
    capture(Buffer.from(value), 'stderr');
  }

  function consumeText(text: string) {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const value = pending + part;
      if (!oversized && Buffer.byteLength(value) <= Math.max(maximumBytes, 8192)) {
        if (part.endsWith('\n')) line(value);
        else pending = value;
      } else {
        if (!oversized) {
          if (value.startsWith('* ')) complete = false;
          else capture(Buffer.from(value), 'stderr');
        }
        oversized = true;
      }
      if (part.endsWith('\n')) {
        pending = '';
        oversized = false;
      } else if (oversized) pending = '';
    }
  }

  return {
    observe(chunk: Buffer, stream: 'stdout' | 'stderr') {
      if (stream === 'stdout') capture(chunk, stream);
      else consumeText(decoder.write(chunk));
    },
    finish() {
      consumeText(decoder.end());
      if (pending) line(pending);
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        requests,
        complete: complete && inFlight === 0,
      };
    },
  };
}

/** Store only bounded metadata in a private, invocation-specific file. */
export async function saveGitHubRequestProfile(
  directory: string,
  context: GitHubProfileContext | undefined,
  profile: Pick<
    ReturnType<ReturnType<typeof createGitHubRequestProfile>['finish']>,
    'requests' | 'complete'
  >,
  exitCode: number | null,
) {
  const label = (value: string | undefined) =>
    value && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
  await new PrivateStateFile({
    directories: [directory],
    path: join(directory, `${randomUUID()}.json`),
    label: 'github request profile',
    maximumBytes: 4 * 1024 * 1024,
    currentUid: process.getuid?.(),
  }).write(
    JSON.stringify({
      version: 1,
      at: Date.now(),
      agentId: label(context?.agentId),
      account: label(context?.account),
      source: label(context?.source),
      exitCode,
      complete: profile.complete,
      requests: profile.requests,
    }) + '\n',
  );
}
