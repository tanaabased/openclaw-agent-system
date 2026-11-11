import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import { deliveryHasEffects } from './delivery-base.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import type { IssueDeliveryState } from './issue-delivery-state.ts';
import workflowRecovery from './workflow-recovery.ts';

/** recovery follows the failed operation and retained effects, never an optional preview. */
export default function openClawDeliveryRecovery(input: {
  operation: string;
  code: string;
  linked: boolean;
  announcement?: Pick<DeliveryAnnouncementState, 'attempted' | 'receipt'>;
  delivery?: IssueDeliveryState;
  diagnostic?: ProviderDiagnostic;
}) {
  const preserve =
    ' Preserve all work and original effect bindings; never create a replacement PR.';
  if (
    /(?:denied|revoked|cancelled|mismatch|diverged|account-changed|owner-changed)$/.test(input.code)
  )
    return (
      'Stop on this denial or identity/authority failure. Restore the original authorized context before continuing; do not retry a write or bypass the denial.' +
      preserve
    );
  const providerRecovery = input.diagnostic && workflowRecovery(input.code, input.diagnostic);
  if (providerRecovery) return providerRecovery.next + preserve;
  const recovery =
    ['compose', 'candidate', 'announce'].includes(input.operation) &&
    (input.announcement?.attempted || input.announcement?.receipt)
      ? 'Use delivery announce in this issue chat to read back the exact original announcement attempt without reposting or selecting the current PR link.'
      : deliveryHasEffects(input.delivery) && !input.delivery?.reconciled
        ? 'Use delivery reconcile in this issue chat to inspect the original PR publication attempt; do not repeat publish.'
        : undefined;
  if (
    [
      'private-state-snapshot-conflict',
      'private-state-file-lock-busy',
      'private-state-file-lock-lost',
    ].includes(input.code)
  )
    return (
      'Concurrent state changed; read the current task context and preserve its retained effects. ' +
      (recovery ??
        `If no write was attempted, retry the same delivery ${input.operation} operation when contention clears.`) +
      preserve
    );
  if (recovery) return recovery + preserve;
  if (
    input.code === 'delivery-announcement-candidate-required' ||
    (input.code === 'delivery-reconciliation-required' && input.linked)
  )
    return (
      'The linked PR does not need a saved publication completion record. Use delivery compose, retain the authored candidate with delivery candidate, then announce. No replacement PR is needed.' +
      preserve
    );
  if (
    input.code === 'delivery-reconciliation-required' ||
    input.code === 'delivery-announcement-binding-required'
  )
    return (
      'No retained PR attempt or current PR link was found. Verify the existing PR and select it with delivery link before composing its announcement. Prepare only previews publication; it does not reconcile saved state.' +
      preserve
    );
  return (
    `Inspect the diagnostic for delivery ${input.operation} and correct that specific failure. Prepare only previews publication; use delivery reconcile for an attempted PR write or delivery announce for an attempted comment. Stop on denial or lost authority.` +
    preserve
  );
}
