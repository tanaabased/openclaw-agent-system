import { isDeepStrictEqual } from 'node:util';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { configuredFeedbackIdentities } from './feedback-policy.ts';
import type { GitHubIdentityPin, GitHubNotificationPolicy } from './workflow-policy.ts';
import type { GitHubNotificationIntakeClient } from './provider/work-event-types.ts';
import type { GitHubIdentity } from './provider/work-item.ts';

import type { BoundStorage } from '../../agent/storage/storage-lifecycle.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';

const maximumBytes = 1024 * 1024;
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

type Purpose = 'assignment' | 'review' | 'review-feedback' | 'feedback' | 'delivery' | 'all';

function pins(policy: GitHubNotificationPolicy, purpose: Purpose = 'all') {
  const result: GitHubIdentityPin[] = [];
  if (purpose === 'review') return policy.reviewRequest?.allowed ?? [];
  if (purpose === 'review-feedback')
    return configuredFeedbackIdentities(
      policy.reviewRequest?.allowed ?? [],
      policy.reviewRequest?.feedback,
    );
  if (purpose === 'all')
    result.push(
      ...(policy.reviewRequest?.allowed ?? []),
      ...(policy.reviewRequest?.feedback?.allowed ?? []),
    );
  const workflow = policy.issueAssignment;
  if (workflow) {
    if (purpose === 'feedback')
      return configuredFeedbackIdentities(workflow.allowed, workflow.feedback);
    if (purpose === 'assignment' || purpose === 'all') result.push(...workflow.allowed);
    if (purpose === 'all') result.push(...(workflow.feedback?.allowed ?? []));
    if (purpose === 'delivery' || purpose === 'all')
      for (const pin of workflow.pullRequest?.recipients ?? [])
        if (!('source' in pin)) result.push(pin);
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
  // Scans refresh names once; individual task operations reuse the verified immutable pins.
  static readonly #refreshed = new WeakMap<object, Map<string, GitHubIdentity>>();
  private readonly cacheScope: string;
  constructor(
    readonly location: { root: string; scope: string },
    private readonly storage: BoundStorage['agent'],
  ) {
    this.cacheScope = JSON.stringify([location.root, location.scope]);
  }

  async read() {
    const rows = await this.storage
      .read({ githubIdentityPins: { scope: this.location.scope } })
      .catch((error: unknown) => {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        return { githubIdentityPins: [] };
      });
    const entries = Object.fromEntries(rows.githubIdentityPins.map(({ id, value }) => [id, value]));
    const state = { version: 1 as const, entries };
    if (!Value.Check(cacheSchema, state)) throw new Error('github-identity-cache-invalid');
    return state;
  }

  /** Passive selection may read existing metadata, but cannot resolve or persist identities. */
  async hydrate(policy: GitHubNotificationPolicy | undefined) {
    if (!policy) return;
    const state = await this.read();
    for (const pin of pins(policy)) {
      const cached = state.entries[key(pin)];
      if (cached && cached.type === 'User') {
        if (!pin.reference && pin.login.toLowerCase() !== cached.login.toLowerCase()) continue;
        Object.assign(pin, { login: cached.login, nodeId: cached.nodeId });
      }
    }
  }

  /** Resolve new pins; discovery scans also refresh retained names by their immutable ids. */
  async resolve(
    policy: GitHubNotificationPolicy | undefined,
    client: Pick<GitHubNotificationIntakeClient, 'resolveIdentity' | 'resolveIdentities'>,
    purpose: Purpose = 'all',
    refresh = false,
  ) {
    if (!policy) return;
    const selected = pins(policy, purpose);
    if (!client.resolveIdentity) {
      if (selected.some((pin) => pin.reference))
        throw new Error('github-identity-resolution-unavailable');
      return;
    }
    const refreshed =
      GitHubIdentityCache.#refreshed.get(client) ?? new Map<string, GitHubIdentity>();
    GitHubIdentityCache.#refreshed.set(client, refreshed);
    const batch = new Map<string, GitHubIdentity>();
    if (client.resolveIdentities) {
      const entries = (await this.read()).entries;
      const references = [
        ...new Set(
          selected.flatMap((pin) => {
            const reference = key(pin);
            if (
              refreshed.has(`${this.cacheScope}\0${reference}`) ||
              (!refresh && entries[reference])
            )
              return [];
            const id = entries[reference]?.nodeId ?? pin.reference ?? pin.nodeId;
            return id.startsWith('@') ? [] : [id];
          }),
        ),
      ];
      if (references.length > 1) {
        for (let start = 0; start < references.length; start += 100) {
          const ids = references.slice(start, start + 100);
          const identities = await client.resolveIdentities(ids);
          if (identities.length !== ids.length) throw new Error('github-identity-unresolved');
          ids.forEach((id, index) => batch.set(id, identities[index]!));
        }
      }
    }
    // Resolve outside the file lease so provider latency cannot block other issue turns.
    // Commit each verified pin before the next lookup, preserving partial progress.
    for (const pin of selected) {
      const reference = key(pin);
      const cacheKey = `${this.cacheScope}\0${reference}`;
      let identity = refreshed.get(cacheKey);
      let resolved = false;
      if (!identity) {
        const retained = (await this.read()).entries[reference];
        identity = !refresh ? retained : undefined;
        if (!identity) {
          const id = retained?.nodeId ?? pin.reference ?? pin.nodeId;
          identity = batch.get(id) ?? (await client.resolveIdentity(id));
          resolved = true;
        }
        if (!Value.Check(identitySchema, identity) || identity.type !== 'User')
          throw new Error('github-identity-type-invalid');
        if (retained && identity.nodeId !== retained.nodeId)
          throw new Error('github-identity-conflict');
      }
      if (identity.type !== 'User') throw new Error('github-identity-type-invalid');
      if (pin.reference && !pin.reference.startsWith('@') && pin.reference !== identity.nodeId)
        throw new Error('github-identity-conflict');
      if (
        !pin.reference &&
        (pin.nodeId !== identity.nodeId || pin.login.toLowerCase() !== identity.login.toLowerCase())
      )
        throw new Error('github-identity-conflict');
      await this.retain(reference, identity);
      if (resolved) refreshed.set(cacheKey, identity);
      Object.assign(pin, { login: identity.login, nodeId: identity.nodeId });
    }
  }

  private async retain(reference: string, identity: GitHubIdentity) {
    if (isDeepStrictEqual((await this.read()).entries[reference], identity)) return;
    return this.storage.retainIdentityPin(
      { scope: this.location.scope, id: reference, value: identity },
      (entries) => {
        const state = { version: 1, entries };
        if (!Value.Check(cacheSchema, state)) throw new Error('github-identity-cache-invalid');
        if (Buffer.byteLength(JSON.stringify(state)) > maximumBytes)
          throw new Error('The GitHub identity cache exceeds its size limit.');
      },
    );
  }
}
