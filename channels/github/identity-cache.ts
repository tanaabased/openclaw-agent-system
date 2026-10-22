import { join } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import PrivateStateFile from '../../core/private-state-file.ts';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock from '../../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../../core/private-state-lock-context.ts';
import type { GitHubIdentityPin, GitHubNotificationPolicy } from './workflow-policy.ts';
import type { GitHubNotificationIntakeClient } from './provider/work-event-types.ts';
import type { GitHubIdentity } from './provider/work-item.ts';

const identitySchema = Type.Object(
  {
    login: Type.String({ minLength: 1 }),
    nodeId: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal('User'), Type.Literal('Organization')]),
  },
  { additionalProperties: false },
);
const cacheSchema = Type.Object(
  {
    version: Type.Literal(1),
    entries: Type.Record(Type.String(), identitySchema),
  },
  { additionalProperties: false },
);

type Purpose = 'assignment' | 'feedback' | 'delivery' | 'all';

function pins(policy: GitHubNotificationPolicy, purpose: Purpose = 'all') {
  const result: Array<{ pin: GitHubIdentityPin; user: boolean }> =
    purpose === 'assignment' || purpose === 'all'
      ? policy.allowedRepositoryOwners.map((pin) => ({ pin, user: false }))
      : [];
  // A reserved workflow cannot cause credential access or provider lookups.
  const workflow = policy.issueAssignment;
  if (workflow) {
    if (purpose !== 'delivery')
      result.push(...workflow.allowed.map((pin) => ({ pin, user: true })));
    if ((purpose === 'feedback' || purpose === 'all') && typeof workflow.feedback === 'object')
      result.push(...workflow.feedback.allowed.map((pin) => ({ pin, user: true })));
    for (const pin of purpose === 'assignment' ? [] : (workflow.pullRequest?.recipients ?? []))
      if (!('source' in pin)) result.push({ pin, user: true });
  }
  return result;
}

function key(pin: GitHubIdentityPin) {
  return pin.reference?.startsWith('@')
    ? pin.reference.toLowerCase()
    : (pin.reference ?? pin.nodeId);
}

/** Non-secret pins belong to a runtime's existing workspace/host intake scope. */
export default class GitHubIdentityCache {
  readonly refreshed = new Map<string, GitHubIdentity>();
  readonly file: PrivateStateFile;
  readonly path: string;
  constructor(readonly location: { root: string; scope: string }) {
    this.path = join(location.root, `github-identities-${location.scope}.json`);
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [location.root],
      label: 'GitHub identity cache',
      maximumBytes: 1024 * 1024,
    });
  }

  async read() {
    const contents = await this.file.read();
    if (contents === undefined)
      return { version: 1 as const, entries: {} as Record<string, GitHubIdentity> };
    const state: unknown = JSON.parse(contents);
    if (!Value.Check(cacheSchema, state)) throw new Error('github-identity-cache-invalid');
    return state;
  }

  /** Passive selection may read existing metadata, but cannot resolve or persist identities. */
  async hydrate(policy: GitHubNotificationPolicy | undefined) {
    if (policy?.schemaVersion !== 3) return;
    const state = await this.read();
    for (const { pin, user } of pins(policy)) {
      const cached = state.entries[key(pin)];
      if (cached && (!user || cached.type === 'User')) {
        if (!pin.reference && pin.login.toLowerCase() !== cached.login.toLowerCase()) continue;
        Object.assign(pin, { login: cached.login, nodeId: cached.nodeId });
      }
    }
  }

  /** An authorized connected consumer refreshes identities before an authority-bearing operation. */
  async resolve(
    policy: GitHubNotificationPolicy | undefined,
    client: Pick<GitHubNotificationIntakeClient, 'resolveIdentity'>,
    purpose: Purpose = 'all',
  ) {
    if (policy?.schemaVersion !== 3) return;
    const selected = pins(policy, purpose);
    if (!client.resolveIdentity) {
      if (selected.some(({ pin }) => pin.reference))
        throw new Error('github-identity-resolution-unavailable');
      return;
    }
    await ensurePrivateStateDirectories({
      directories: [this.location.root],
      label: 'GitHub identity cache',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      await withPrivateStateLock(lock, async () => {
        const state = await this.read();
        const resolved = this.refreshed;
        // Commit successful first resolutions even when a later entry fails: a retry must
        // never silently bind the same name to a different account.
        for (const { pin, user } of selected) {
          const reference = key(pin);
          let identity = resolved.get(reference);
          if (!identity) {
            const retained = state.entries[reference];
            const lookup = retained?.nodeId ?? pin.reference ?? pin.nodeId;
            identity = await client.resolveIdentity!(lookup);
            if (!Value.Check(identitySchema, identity) || (user && identity.type !== 'User'))
              throw new Error('github-identity-type-invalid');
            if (
              (retained && identity.nodeId !== retained.nodeId) ||
              (pin.reference &&
                !pin.reference.startsWith('@') &&
                pin.reference !== identity.nodeId) ||
              (!pin.reference &&
                (identity.nodeId !== pin.nodeId ||
                  identity.login.toLowerCase() !== pin.login.toLowerCase()))
            )
              throw new Error('github-identity-conflict');
            state.entries[reference] = identity;
            await this.file.write(JSON.stringify(state));
            resolved.set(reference, identity);
          }
          if (user && identity.type !== 'User') throw new Error('github-identity-type-invalid');
          if (pin.reference && !pin.reference.startsWith('@') && pin.reference !== identity.nodeId)
            throw new Error('github-identity-conflict');
          if (
            !pin.reference &&
            (pin.nodeId !== identity.nodeId ||
              pin.login.toLowerCase() !== identity.login.toLowerCase())
          )
            throw new Error('github-identity-conflict');
          Object.assign(pin, { login: identity.login, nodeId: identity.nodeId });
        }
      });
    } finally {
      await lock.release();
    }
  }
}
