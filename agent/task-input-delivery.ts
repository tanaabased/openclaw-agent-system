export type TaskInputReceipt =
  { status: 'delivered' } | { status: 'pending' } | { status: 'held'; code: string };

/** Retained attempts reconcile before any new source read or send. */
export default async function deliverTaskInput<T>(input: {
  attempt: T | undefined;
  prepare(): Promise<T>;
  retain(attempt: T): void;
  send?(attempt: T): Promise<void>;
  reconcile?(attempt: T): Promise<TaskInputReceipt>;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}): Promise<TaskInputReceipt> {
  const reconcile = (attempt: T) => input.reconcile?.(attempt) ?? { status: 'pending' as const };
  if (input.attempt) return reconcile(input.attempt);
  await input.assertCurrent();
  const attempt = await input.prepare();
  input.retain(attempt);
  await input.save();
  await input.assertCurrent();
  // Codex exposes the retained request to its native tool caller; OpenClaw sends here.
  if (!input.send) return { status: 'pending' };
  await input.send(attempt);
  await input.save();
  return reconcile(attempt);
}
