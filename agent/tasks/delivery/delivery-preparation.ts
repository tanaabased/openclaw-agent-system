import { deliveryHasEffects, selectDeliveryBase } from './delivery-base.ts';
import type { IssueDeliveryState } from './issue-delivery-state.ts';

export function selectDeliveryDestination(input: {
  requestedBase?: string;
  repositoryDefault: string;
  selectedBase?: string;
  previous?: IssueDeliveryState;
}) {
  const retainedBase =
    input.selectedBase ??
    (deliveryHasEffects(input.previous) ? input.previous?.binding.base : undefined);
  return {
    base: selectDeliveryBase(input.requestedBase, input.repositoryDefault, retainedBase),
    retainedBase,
  };
}

const bindingReasons = {
  repositoryId: 'repository',
  issueId: 'issue',
  sessionId: 'session',
  threadId: 'thread',
  worktree: 'worktree',
  branch: 'branch',
  base: 'base',
  authorId: 'account',
} as const;

export function assertDeliveryBinding(
  previous: IssueDeliveryState | undefined,
  current: IssueDeliveryState['binding'],
) {
  if (!previous) return;
  const fields: Array<keyof typeof bindingReasons> = [
    'repositoryId',
    'issueId',
    // native adapters supply an incarnation only when their host owns one.
    ...('sessionId' in current ? (['sessionId'] as const) : []),
    'threadId',
    'worktree',
    ...(deliveryHasEffects(previous) ? (['branch', 'base'] as const) : []),
    'authorId',
  ];
  const changed = fields.find((field) => previous.binding[field] !== current[field]);
  if (changed) throw new Error(`delivery-${bindingReasons[changed]}-changed`);
}

export function deliveryContentUpdate(
  previous: IssueDeliveryState | undefined,
  content: Pick<IssueDeliveryState, 'title' | 'body'>,
) {
  return {
    ...previous?.contentUpdate,
    ...(previous?.pullRequest && content.title !== previous.title ? { title: content.title } : {}),
    ...(previous?.pullRequest && content.body !== previous.body ? { body: content.body } : {}),
  };
}
