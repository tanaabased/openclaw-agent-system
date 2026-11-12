import type { DispatchProject } from './codex-dispatch-state.ts';
import { deliveryHasEffects, selectDeliveryBase } from './delivery-base.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { managedPullRequest, type ManagedIssue } from './managed-issue.ts';

export type AssessmentGitRecord = SharedDispatchRecord & {
  project?: Pick<DispatchProject, 'ref' | 'commit'>;
};

/** retained checkout evidence only; current head and nearby names cannot recover the source. */
export async function assessmentGitContext(
  record: AssessmentGitRecord,
  admitted: ManagedIssue,
  repositoryDefault?: () => Promise<string | undefined>,
) {
  const pullRequest = managedPullRequest(admitted);
  const adopted = record.adoptedPullRequest ?? record.delivery?.adopted;
  // delivery binding may select a pr after checkout creation; its head is not starting evidence.
  const startingAdoption = !record.delivery ? record.adoptedPullRequest : undefined;
  const checkout = record.project ??
    (pullRequest && { commit: pullRequest.headSha, ref: pullRequest.headRef }) ?? {
      commit: startingAdoption?.head,
      ref: startingAdoption?.branch,
    };
  const retainedBase =
    pullRequest?.baseRef ??
    adopted?.base ??
    (deliveryHasEffects(record.delivery) ? record.delivery?.binding.base : undefined);
  let defaultBranch: string | undefined;
  if (!retainedBase) {
    try {
      defaultBranch = await repositoryDefault?.();
    } catch {
      // diagnostic reads never invalidate assessment or discard independent checkout evidence.
    }
  }
  return {
    checkoutStartingPoint: {
      commit: checkout.commit,
      ref: checkout.ref?.replace(/^refs\/(?:heads|tags|remotes)\//u, ''),
    },
    prBase: selectDeliveryBase(undefined, defaultBranch ?? 'unknown', retainedBase),
  };
}
