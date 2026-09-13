import { resolve } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { resolveCommandAuthorization } from 'openclaw/plugin-sdk/command-auth';

import type GitHubAccountClient from '../../core/github-account-client.ts';
import type {
  AgentSystemLifecycleContext,
  AgentSystemLifecycleFinding,
} from '../../core/lifecycle-registry.ts';
import { configuredAgentValue } from '../../core/configured-agents.ts';
import type { GitHubApprovedActor } from './config-schema.ts';
import type OperatorGrantStore from './operator-grant-store.ts';
import type { OperatorGrantClaim, OperatorGrantState } from './operator-grant-store.ts';
import type { NotificationRoutingServiceDependencies } from './routing/service.ts';
import { githubNotificationChannelId } from './routing/routing.ts';

type Finding = Omit<AgentSystemLifecycleFinding, 'component'>;
const remediation =
  'Run openclaw agent-system install from the declaring agent workspace. Reload the Gateway if its loaded permissions are stale, then verify a fresh assignment.';
const loadedAccessRemediation = 'Reload the Gateway, then verify a fresh assignment.';
const scope =
  'This is channel-wide OpenClaw operator recognition, not repository-scoped or styling-only access; independent tool policy still applies.';

export interface OperatorAccessDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  store: Pick<OperatorGrantStore, 'read' | 'write' | 'withLock'>;
  mutateConfigFile: NotificationRoutingServiceDependencies['mutateConfigFile'];
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  readRuntimeConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  reportPlan(message: string): void;
}

function desiredActors(context: AgentSystemLifecycleContext): GitHubApprovedActor[] {
  return (
    context.manifest.github?.notifications?.approvedActors.filter(
      (actor) => actor.operatorOwner === true,
    ) ?? []
  );
}

export function operatorOwnerIdentity(actor: GitHubApprovedActor): string {
  return `${githubNotificationChannelId}:${actor.nodeId}`;
}

function claim(context: AgentSystemLifecycleContext): OperatorGrantClaim {
  return { agentId: context.manifest.agent.id, workspaceDir: resolve(context.workspaceDir) };
}

function sameClaim(left: OperatorGrantClaim, right: OperatorGrantClaim): boolean {
  return left.agentId === right.agentId && left.workspaceDir === right.workspaceDir;
}

function ownerEntries(config: OpenClawConfig): Array<string | number> {
  const value = config.commands?.ownerAllowFrom;
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' && !(typeof entry === 'number' && Number.isFinite(entry)),
    )
  ) {
    throw new Error('Owner configuration cannot be verified.');
  }
  return [...value];
}

function warning(code: string, message: string, remedy = remediation): Finding {
  return { code: `github-operator-${code}`, message, remediation: remedy, status: 'warning' };
}

/** Ask the host's authorization resolver; do not dispatch a turn or replace its sender. */
export function inspectOperatorRecognition(
  config: OpenClawConfig,
  actor: GitHubApprovedActor,
): boolean {
  return resolveCommandAuthorization({
    cfg: config,
    commandAuthorized: true,
    ctx: {
      Provider: githubNotificationChannelId,
      Surface: githubNotificationChannelId,
      OriginatingChannel: githubNotificationChannelId,
      SenderId: actor.nodeId,
      ChatType: 'direct',
    },
  }).senderIsOwner;
}

function knownSessionDenial(config: OpenClawConfig, agentId: string): boolean {
  const denies = [config.tools?.deny, configuredAgentValue(config, agentId)?.tools?.deny];
  return denies.some((list) =>
    list?.some((pattern) => {
      const expression = pattern
        .toLowerCase()
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('.*');
      return new RegExp(`^${expression}$`, 'u').test('sessions');
    }),
  );
}

/** Doctor inspects desired access; only explicit install reconciles grants and provenance. */
export default class GitHubOperatorAccess {
  constructor(readonly dependencies: OperatorAccessDependencies) {}

  async #verify(
    context: AgentSystemLifecycleContext,
    actors: GitHubApprovedActor[],
  ): Promise<void> {
    if (actors.length === 0) return;
    const client = await this.dependencies.accountClient.connect(context);
    for (const actor of actors) {
      const result = await client.execute([
        'api',
        `users/${actor.login}`,
        '--jq',
        '{login:.login,nodeId:.node_id}',
      ]);
      if (result.exitCode !== 0 || result.truncated || result.timedOut)
        throw new Error('identity lookup failed');
      const identity: unknown = JSON.parse(result.stdout);
      if (
        !identity ||
        typeof identity !== 'object' ||
        !('login' in identity) ||
        !('nodeId' in identity) ||
        typeof identity.login !== 'string' ||
        identity.login.toLowerCase() !== actor.login.toLowerCase() ||
        identity.nodeId !== actor.nodeId
      )
        throw new Error('identity pin mismatch');
    }
  }

  async inspect(context: AgentSystemLifecycleContext): Promise<Finding[]> {
    const actors = desiredActors(context);
    if (actors.length === 0) return [];
    try {
      await this.#verify(context, actors);
    } catch {
      return actors.map((actor) =>
        warning(
          'identity-unverified',
          `Desired operator identity for ${actor.login} (${operatorOwnerIdentity(actor)}) could not be verified; no grant is implied.`,
        ),
      );
    }
    let config: OpenClawConfig;
    let loaded: OpenClawConfig | undefined;
    try {
      config = await this.dependencies.readConfig();
      ownerEntries(config);
    } catch {
      return actors.map((actor) =>
        warning(
          'config-unverified',
          `Desired operator access for ${actor.login} could not be inspected.`,
        ),
      );
    }
    try {
      loaded = await this.dependencies.readRuntimeConfig();
    } catch {
      /* report per actor below */
    }
    return actors.flatMap((actor) => {
      const findings: Finding[] = [];
      const identity = operatorOwnerIdentity(actor);
      if (!ownerEntries(config).includes(identity)) {
        findings.push(
          warning(
            'owner-missing',
            `Desired channel-qualified operator entry for ${actor.login} (${identity}) is absent. ${scope}`,
          ),
        );
      } else {
        let recognized = false;
        try {
          recognized = loaded !== undefined && inspectOperatorRecognition(loaded, actor);
        } catch {
          /* optional inspection */
        }
        findings.push(
          recognized
            ? {
                code: 'github-operator-owner-configured',
                status: 'healthy',
                message: `${actor.login} (${identity}) is saved and recognized by this process. This does not prove the running Gateway has reloaded or that sessions is available; verify a fresh assignment.`,
              }
            : warning(
                'loaded-access-unverified',
                `Running Gateway access for ${actor.login} is unverified. Reload the Gateway, then verify a fresh assignment.`,
                loadedAccessRemediation,
              ),
        );
      }
      if (knownSessionDenial(config, context.manifest.agent.id)) {
        findings.push(
          warning(
            'sessions-denied',
            `Independent tool policy denies sessions for ${actor.login}; install will not override that denial.`,
          ),
        );
      }
      return findings;
    });
  }

  async reconcile(context: AgentSystemLifecycleContext) {
    const outcomes: Array<{ code: string; message: string; status: 'updated' | 'unchanged' }> = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const actors = desiredActors(context);
    try {
      await this.#verify(context, actors);
    } catch {
      for (const actor of actors)
        warnings.push(
          warning(
            'identity-unverified',
            `Operator identity for ${actor.login} (${operatorOwnerIdentity(actor)}) could not be verified. No grants or claims were changed.`,
          ),
        );
      return { outcomes, warnings };
    }
    try {
      await this.dependencies.store.withLock(async () => {
        const before = await this.dependencies.store.read();
        const currentClaim = claim(context);
        const desired = new Set(actors.map(operatorOwnerIdentity));
        if (
          desired.size === 0 &&
          !before.grants.some((grant) =>
            grant.claims.some((entry) => sameClaim(entry, currentClaim)),
          )
        )
          return;
        const initial = ownerEntries(await this.dependencies.readConfig());
        const next = structuredClone(before);
        const additions = new Set<string>();
        const removals = new Set<string>();
        for (const grant of next.grants) {
          const ours = grant.claims.some((entry) => sameClaim(entry, currentClaim));
          if (!ours && !desired.has(grant.identity)) continue;
          grant.claims = grant.claims.filter((entry) => !sameClaim(entry, currentClaim));
          if (desired.has(grant.identity)) grant.claims.push(currentClaim);
          const copies = initial.filter((entry) => entry === grant.identity).length;
          if (copies > 1 && grant.origin === 'created') grant.origin = 'ambiguous';
          if (grant.claims.length === 0 && copies > 0) {
            if (grant.origin === 'created' && copies === 1) removals.add(grant.identity);
            else
              warnings.push(
                warning(
                  'grant-retained',
                  `${grant.identity} remains accessible: its grant is ${grant.origin}. Revocation was not performed.`,
                ),
              );
          } else if (ours && !desired.has(grant.identity) && grant.claims.length > 0) {
            warnings.push(
              warning(
                'grant-shared',
                `${grant.identity} is still required by another installation; only this declaration's claim was retired.`,
              ),
            );
          }
        }
        for (const identity of desired) {
          let grant = next.grants.find((entry) => entry.identity === identity);
          if (!grant) {
            grant = {
              identity,
              origin: initial.includes(identity) ? 'preexisting' : 'created',
              claims: [currentClaim],
            };
            next.grants.push(grant);
          }
          if (!initial.includes(identity)) {
            additions.add(identity);
            // a fresh creation is provable even when an older grant was manual or ambiguous.
            grant.origin = 'created';
          }
        }
        this.dependencies.reportPlan(
          `GitHub operator reconciliation: desired=${[...desired].join(', ') || 'none'}; remove=${[...removals].join(', ') || 'none'}. ${scope}`,
        );
        const pending: OperatorGrantState = structuredClone(next);
        for (const grant of pending.grants) {
          if (additions.has(grant.identity) || removals.has(grant.identity))
            grant.origin = 'ambiguous';
          if (removals.has(grant.identity)) grant.claims.push(currentClaim);
        }
        // persist intent first; a crash before the verified receipt never proves ownership.
        await this.dependencies.store.write(pending);
        if (JSON.stringify(await this.dependencies.store.read()) !== JSON.stringify(pending)) {
          throw new Error('Operator grant intent could not be verified.');
        }
        const expected = initial.filter(
          (identity) => typeof identity !== 'string' || !removals.has(identity),
        );
        for (const identity of additions) expected.push(identity);
        // deduplicate only opted-in identities; duplicates of formerly owned grants stay ambiguous.
        const seen = new Set<string>();
        const target = expected.filter((identity) => {
          if (typeof identity !== 'string' || !desired.has(identity)) return true;
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        });
        const changed = JSON.stringify(initial) !== JSON.stringify(target);
        if (changed) {
          await this.dependencies.mutateConfigFile({
            base: 'source',
            afterWrite: { mode: 'auto' },
            mutate(config) {
              if (JSON.stringify(ownerEntries(config)) !== JSON.stringify(initial))
                throw new Error('Owner configuration changed during reconciliation.');
              (config.commands ??= {}).ownerAllowFrom = target;
              return true;
            },
          });
        }
        const saved = ownerEntries(await this.dependencies.readConfig());
        if (JSON.stringify(saved) !== JSON.stringify(target))
          throw new Error('Owner configuration read-back did not match.');
        next.grants = next.grants.filter(
          (grant) =>
            grant.claims.length > 0 ||
            (saved.includes(grant.identity) && grant.origin === 'ambiguous'),
        );
        await this.dependencies.store.write(next);
        if (JSON.stringify(await this.dependencies.store.read()) !== JSON.stringify(next)) {
          throw new Error('Operator grant receipt could not be verified.');
        }
        outcomes.push({
          code: 'github-operator-grants-reconciled',
          status: changed ? 'updated' : 'unchanged',
          message: `Operator ${actors.length === 1 ? 'entry' : 'entries'} for ${actors.map(({ login }) => login).join(', ') || 'retired declarations'} ${actors.length === 1 ? 'is' : 'are'} saved.`,
        });
      });
    } catch {
      warnings.push(
        warning(
          'reconciliation-unverified',
          'Operator grant reconciliation could not be verified. Existing or partially saved access may remain; no revocation or effective permission change is claimed. Inspect provenance and rerun install.',
        ),
      );
    }
    if (actors.length > 0) {
      warnings.push(
        ...(await this.inspect(context)).filter((finding) => finding.status === 'warning'),
      );
    }
    return { outcomes, warnings };
  }
}
