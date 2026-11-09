import WorkflowRequestError from '../../agent/workflow-request-error.ts';

/** Describe the selected operation without echoing submitted values or ownership selectors. */
export default function invalidDeliveryRequest(
  operation: unknown,
  runtime: 'codex' | 'openclaw',
  detail = '',
) {
  const link =
    runtime === 'codex' ? '{"action":"link"}' : '{"action":"delivery","operation":"link"}';
  const instruction =
    operation === 'link'
      ? `Use ${link} to link the published PR. Only an explicit association change needs pullRequest (a PR URL or null); url and target are not delivery fields.`
      : operation === 'bind'
        ? 'Use pullRequest for the explicit same-repository PR URL. Do not use url or target.'
        : operation === 'prepare' || operation === 'publish'
          ? 'Supply authored title and body when needed for publication; the runtime verifies the checkout.'
          : operation === 'candidate'
            ? 'Supply the authored announcement in publicText; the runtime binds its destination and publication context.'
            : operation === 'compose'
              ? 'Compose selects the configured announcement guidance. Omit publication text and PR selectors; use the returned material request only when paging is needed.'
              : operation === 'announce'
                ? 'Announce publishes or reconciles the retained announcement candidate. Omit title, body, publicText and PR selectors.'
                : operation === 'present' || operation === 'reconcile'
                  ? 'Use the selected operation without authored content or PR selectors; the runtime resolves the retained delivery.'
                  : 'Select link, bind, prepare, publish, reconcile, present, compose, candidate or announce.';
  return new WorkflowRequestError(
    'delivery-request-invalid',
    `${detail ? `${detail}. ` : ''}${instruction} The runtime resolves task identity; do not supply IDs, digests or authority fields.`,
  );
}
