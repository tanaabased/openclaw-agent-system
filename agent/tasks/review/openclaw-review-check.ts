import GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { selectOpenClawTaskContext } from '../context/openclaw-task-context.ts';
import type { OpenClawDispatchDependencies } from '../dispatch/openclaw-dispatch-context.ts';
import { scanReviewFeedback } from './openclaw-review-feedback.ts';
import workflowFailure from '../workflow-failure.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import { claimRouteEligibility, readAssignmentClaims } from '../dispatch/assignment-claim.ts';
import reviewClaimSource from './review-claim-source.ts';
import reviewPolicy from './review-policy.ts';
import discoverReviews from './discover-reviews.ts';
import observeReview from './review-observation.ts';
import { reviewKey, type ReviewAdmission } from './review-admission.ts';
import { assertNotificationManagement } from '../../notification-reset-state.ts';

/** A predicate observes both outstanding requests and the owners GitHub no longer lists after submission. */
export default async function openClawReviewCheck(
  deps: OpenClawDispatchDependencies,
  manifest: AgentManifest,
  workspace: string,
  signal: AbortSignal,
) {
  const selected = reviewPolicy(manifest, 'openclaw');
  if (!selected || selected.policy.reviewRequest?.paused)
    return { status: 'ready', changed: false };
  const { policy } = selected;
  const current = await selectOpenClawTaskContext(deps.taskContext, manifest, workspace, {
    resolvePolicy: false,
  });
  const scope = current.store.location.scope;
  await assertNotificationManagement(deps.root, scope, current.store.agentStorage);
  const journal = current.dispatch(deps.root);
  const state = await journal.read();
  const records = state.records.filter((r) => r.reviewAdmission && !r.reset && !r.supersededBy);
  const pending = new Map<string, ReviewAdmission>(
    records.map((r) => [r.issueKey, r.reviewAdmission!]),
  );
  const client = await deps.connect({ manifest, workspaceDir: workspace }, signal);
  if (
    !(client instanceof GitHubWorkEventClient) ||
    client.identity.login.toLowerCase() !== selected.username.toLowerCase()
  )
    throw new Error('review-account-mismatch');
  await current.store.identities.resolve(policy, client, 'review');
  const obstacles = await discoverReviews(
    client,
    policy,
    { scope, workspaceDir: workspace, agentId: manifest.agent.id },
    Date.now(),
    signal,
    async (admission) => {
      const key = reviewKey(admission);
      if (!records.some((r) => r.issueKey === key && r.request)) pending.set(key, admission);
    },
  );
  for (const [key, admission] of pending) {
    try {
      const r = records.find((record) => record.issueKey === key);
      const observed = await observeReview(
        admission,
        client,
        policy,
        !!r?.sessionCreation?.verified,
      );
      if (
        !r?.request &&
        observed.status === 'ready' &&
        admission.origin.kind === 'request' &&
        deps.claims
      ) {
        const route = repositoryScope(policy, observed.repository, 'review-request');
        if (await claimRouteEligibility(deps.claims.store, route)) continue;
        if (route.decision === 'swarm') {
          const winner = (
            await readAssignmentClaims(deps.claims.connect(client), reviewClaimSource(admission))
          )[0]?.claim;
          if (winner && winner.instanceId !== (await deps.claims.store.inspect())?.instanceId)
            continue;
        }
      }
      if ((observed.status === 'closed' && r?.request) || r?.retirement)
        return { status: 'ready', changed: true, obstacles };
      if (observed.status === 'ready' && r?.sessionCreation?.verified) {
        await current.store.identities.resolve(policy, client, 'review-feedback', true);
        if (await scanReviewFeedback(r, deps, client, policy))
          return { status: 'ready', changed: true, obstacles };
      }
      if (
        observed.status === 'ready' &&
        (!r?.sessionCreation?.verified ||
          observed.fingerprint !== r.reviewObservation ||
          r.nativeTurns?.some((t) => t.role === 'review' && t.turn.status === 'attempted'))
      )
        return { status: 'ready', changed: true, obstacles };
    } catch (error) {
      signal.throwIfAborted();
      obstacles.push({ code: workflowFailure(error, 'review-request-observation-failed').code });
    }
  }
  return { status: 'ready', changed: obstacles.length > 0, obstacles };
}
