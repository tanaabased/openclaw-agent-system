import { realpath } from 'node:fs/promises';

import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import type { ImplementationResult } from './implementation-result.ts';
import { replyLocator } from './reply-target.ts';

/** native adapters verify custody; matching work keeps its owner, scope and original receipts. */
export default async function managedImplementationRoute<T>(input: {
  action: unknown;
  currentTarget?: string;
  managed: AssessmentEntryDependencies['managed'];
  route(owner: { id: string; eventId?: string }, result?: ImplementationResult): Promise<T>;
}) {
  const action = parseDirectImplementationRequest(input.action);
  const target = action.target ?? input.currentTarget;
  if (!target) return;
  const locator = replyLocator(target);
  if (locator.itemType !== 'issue' || locator.kind)
    throw new Error('implementation-issue-url-required');
  const owner = await input.managed({
    repository: `${locator.owner}/${locator.name}`,
    number: locator.number,
  });
  if (!owner) return;
  if (
    !owner.owner ||
    (action.id && action.id !== owner.owner.id) ||
    (action.path && (await realpath(action.path)) !== owner.path)
  )
    throw new Error('implementation-managed-context-mismatch');
  return { result: await input.route(owner.owner, owner.implementationResult) };
}
