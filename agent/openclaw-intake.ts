import { realpath } from 'node:fs/promises';

import { cliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import {
  githubNotificationRuntimeBlocker,
  githubNotificationRuntimeDiagnostics,
} from '../channels/github/notification-policy.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeLocation,
} from '../channels/github/intake/record-store.ts';
import scanAssignments, {
  type AssignmentScanInput,
} from '../channels/github/intake/scan-assignments.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type { AgentSystemLifecycleContribution } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { GitHubNotificationItemSelector } from '../channels/github/provider/work-item.ts';

export interface OpenClawIntakeDependencies {
  root: string;
  namespace: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  connect(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
  ): Promise<GitHubNotificationIntakeClient>;
  now?: () => number;
}

/** V2 admission only. No sessions, assessment results, V1 files or publication. */
export default class OpenClawIntake {
  constructor(readonly dependencies: OpenClawIntakeDependencies) {}
  async select(manifest: AgentManifest, workspaceDir: string) {
    const workspace = await realpath(workspaceDir);
    const selected = assignmentIntakePolicy(manifest, 'openclaw');
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: 'openclaw',
        root: this.dependencies.root,
        namespace: this.dependencies.namespace,
        workspaceDir: workspace,
        agentId: manifest.agent.id,
      }),
    );
    return { selected, store, workspace };
  }
  async inspect(manifest: AgentManifest, workspaceDir: string) {
    const blocker = githubNotificationRuntimeBlocker(manifest.github?.notifications, 'openclaw');
    if (blocker)
      return {
        status: 'blocked',
        code: blocker.code,
        baselineAt: null,
        checkpoint: null,
        records: [],
      };
    const { selected, store } = await this.select(manifest, workspaceDir);
    const state = await store.read();
    const code = !selected
      ? 'intake-policy-disabled'
      : !state
        ? 'intake-activation-required'
        : state.policyDigest !== selected.digest
          ? 'intake-policy-reconciliation-required'
          : state.blocker?.code;
    return {
      status: code ? 'blocked' : 'ready',
      ...(code ? { code } : {}),
      baselineAt: state?.baselineAt ?? null,
      checkpoint: state?.checkpoint ?? null,
      records: state?.records ?? [],
    };
  }
  async run(
    manifest: AgentManifest,
    workspaceDir: string,
    action: 'check' | 'scan' | 'activate',
    expectedDigest?: string,
    signal?: AbortSignal,
    selector?: GitHubNotificationItemSelector,
  ) {
    signal?.throwIfAborted();
    const blocker = githubNotificationRuntimeBlocker(manifest.github?.notifications, 'openclaw');
    if (blocker) throw new IntakeError(blocker.code);
    const deadline = AbortSignal.timeout(action === 'check' ? 25000 : 120000);
    const { selected, store, workspace } = await this.select(manifest, workspaceDir);
    if (!selected) throw new IntakeError('intake-policy-disabled');
    if (action !== 'activate' && expectedDigest !== selected.digest)
      throw new IntakeError('intake-policy-changed');
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      deadline.throwIfAborted();
      const fresh = await this.dependencies.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (
        fresh.status !== 'loaded' ||
        fresh.manifest.agent.id !== manifest.agent.id ||
        (await realpath(fresh.scope.workspaceDir)) !== workspace ||
        assignmentIntakePolicy(fresh.manifest, 'openclaw')?.digest !== selected.digest
      )
        throw new IntakeError('intake-policy-changed');
    };
    await assertCurrent();
    const target: AssignmentScanInput['store'] =
      action === 'check'
        ? {
            location: store.location,
            async exclusive(run) {
              const state = await store.read();
              return run(
                state ? structuredClone(state) : undefined,
                async () => {},
                new AbortController().signal,
              );
            },
          }
        : store;
    return scanAssignments({
      store: target,
      workspaceDir: workspace,
      agentId: manifest.agent.id,
      policy: selected.policy,
      policyDigest: selected.digest,
      now: (this.dependencies.now ?? Date.now)(),
      activate: action === 'activate',
      selector,
      assertCurrent,
      connect: async (lockSignal) => {
        await assertCurrent();
        const client = await this.dependencies.connect(
          { manifest, workspaceDir: workspace },
          AbortSignal.any([lockSignal, deadline, ...(signal ? [signal] : [])]),
        );
        const pin = selected.policy.issueAssignment?.allowed.find(
          (a) => a.login.toLowerCase() === selected.username.toLowerCase(),
        );
        if (
          client.identity.login.toLowerCase() !== selected.username.toLowerCase() ||
          (pin && pin.nodeId !== client.identity.nodeId)
        )
          throw new IntakeError('intake-github-identity-mismatch');
        return client;
      },
    });
  }
  contribution(): AgentSystemLifecycleContribution {
    return {
      id: 'github-intake',
      isConfigured: (manifest) => manifest.github?.notifications?.schemaVersion === 2,
      validate: ({ manifest }) => {
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        return {
          code: 'github-notifications-declaration-valid',
          summary: 'GitHub notification declaration',
          diagnostics: diagnostics.map(({ code, message, fieldPath, workflow, remediation }) => ({
            [cliDiagnosticContext]: {
              condition: {
                key: `notification-capability:${workflow}`,
                component: 'github-intake',
                fieldPath,
              },
              remediation: [remediation],
            },
            code,
            message,
            fieldPath,
            severity: 'warning' as const,
          })),
        };
      },
      inspect: async ({ manifest, workspaceDir }) => {
        const result = await this.inspect(manifest, workspaceDir);
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        if (result.code === 'github-notification-runtime-unsupported') return diagnostics;
        return [
          ...diagnostics,
          {
            component: 'github-intake',
            status:
              result.code === 'intake-policy-disabled'
                ? 'skipped'
                : result.code
                  ? 'drift'
                  : 'healthy',
            code: result.code ?? 'intake-ready',
            message: result.code ?? 'Intake baseline and policy are aligned.',
          },
        ];
      },
      reconcile: async ({ manifest, workspaceDir }) => {
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        const warnings = diagnostics.map(({ code, message, fieldPath, workflow, remediation }) => ({
          code,
          message,
          [cliDiagnosticContext]: {
            condition: {
              key: `notification-capability:${workflow}`,
              component: 'github-intake',
              fieldPath,
            },
            remediation: [remediation],
          },
        }));
        const blocker = diagnostics.find(
          ({ status, workflow }) => status === 'blocked' && workflow === 'issue-assignment',
        );
        if (blocker)
          return {
            outcomes: [{ ...blocker, status: 'skipped' as const }],
            warnings,
          };
        if (!assignmentIntakePolicy(manifest, 'openclaw')) return { outcomes: [], warnings };
        const state = await this.inspect(manifest, workspaceDir);
        if (
          state.code &&
          ['intake-activation-required', 'intake-policy-reconciliation-required'].includes(
            state.code,
          )
        ) {
          const result = await this.run(manifest, workspaceDir, 'activate');
          if (result.status !== 'ready')
            throw new IntakeError(result.code ?? 'intake-activation-required');
          return {
            warnings,
            outcomes: [
              {
                component: 'github-intake',
                status: 'updated',
                code: 'intake-activated',
                message: 'Intake baseline and policy retained; no issue sessions created.',
              },
            ],
          };
        }
        return {
          warnings,
          outcomes: [
            {
              component: 'github-intake',
              status: 'unchanged',
              code: 'intake-retained',
              message: 'Intake evidence retained.',
            },
          ],
        };
      },
    };
  }
}
