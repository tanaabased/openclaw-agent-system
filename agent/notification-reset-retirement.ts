import NotificationResetStore from './notification-reset-state.ts';

/** Unrelated native disposal remains available while reset retains its own resources. */
export default async function assertNotificationResetRetirement(
  root: string,
  scope: string,
  target: string,
  cwd?: string,
) {
  const reset = await new NotificationResetStore(root, scope).read();
  if (!reset) return;
  const jobs = [reset.automation, ...(reset.pickup ? [reset.pickup.automation] : [])].map((saved) =>
    JSON.parse(saved),
  );
  const inventory = JSON.parse(reset.inventory);
  if (
    reset.resources.some(
      (resource) =>
        (['chat', 'coordinator'].includes(resource.kind) && resource.description === target) ||
        (resource.kind === 'worktree' && cwd !== undefined && resource.description === cwd),
    ) ||
    jobs.some((job) => job.sessionKey === target || job.definition?.targetThreadId === target) ||
    inventory.records.some(
      (record: {
        threadId?: string;
        receiptThreadId?: string;
        request?: { key?: string };
        worktree?: string;
      }) =>
        [record.threadId, record.receiptThreadId, record.request?.key].includes(target) ||
        (cwd !== undefined && record.worktree === cwd),
    )
  )
    throw new Error('notification-reset-resource-in-progress');
}
