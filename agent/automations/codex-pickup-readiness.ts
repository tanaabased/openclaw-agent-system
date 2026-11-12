import type { AgentSystemLifecycleFinding } from '../../core/lifecycle-registry.ts';
import type { GitHubNotificationPolicy } from '../../channels/github/workflow-policy.ts';
import {
  selectCodexTaskContext,
  type CodexTaskContextDependencies,
} from '../tasks/context/codex-task-context.ts';
import { codexInstanceStore } from '../tasks/dispatch/codex-assignment-claims.ts';
import IssuePickupEnrollmentStore from '../issue-pickup-enrollment.ts';
import { issuePickupConfigurationCode, issuePickupErrorCode } from './issue-pickup-jobs.ts';
import { inspectCodexPickupActivation } from './codex-automation-activation.ts';

export async function inspectCodexPickup(
  pluginData: string,
  deps: CodexTaskContextDependencies = {},
) {
  const current = await selectCodexTaskContext(pluginData, deps, { inspectionOnly: true });
  return inspectSelectedCodexPickup(
    pluginData,
    current.policy?.policy,
    current.store.location.scope,
    () =>
      inspectCodexPickupActivation(pluginData, {
        codexHome: current.codexHome,
        inspectBinding: deps.inspectBinding,
      }),
  );
}

/** planning may reuse selected ownership; standalone inspection selects fresh native evidence. */
export async function inspectSelectedCodexPickup(
  pluginData: string,
  policy: GitHubNotificationPolicy | undefined,
  scope: string,
  activate: () => Promise<{ nativeId: string }>,
): Promise<AgentSystemLifecycleFinding[]> {
  if (!policy?.issuePickup) return [];
  let code: string | undefined = issuePickupConfigurationCode(policy);
  try {
    if (!code) {
      const record = await new IssuePickupEnrollmentStore(
        codexInstanceStore(pluginData).root,
      ).inspect(policy, 'codex', scope);
      const native = await activate();
      if (record.nativeId !== native.nativeId) code = 'issue-pickup-enrollment-changed';
    }
  } catch (error) {
    code = issuePickupErrorCode(error);
  }
  return [
    {
      component: 'github-intake',
      status: code ? ('drift' as const) : ('healthy' as const),
      code: code ?? 'issue-pickup-ready',
      message: code ?? 'Issue pickup enrollment and native schedule are ready.',
      ...(code
        ? {
            remediation:
              'Check the designated installation, cadence and window, then run Install and acknowledge its native pickup job. Preserve pending pickup work.',
          }
        : {}),
    },
  ];
}
