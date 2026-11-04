import { GitHubWorkEventClientError } from './work-event-api-client.ts';

/** an unavailable item may be deferred; account, throttle and transport failures stop the scan. */
export default function itemReadFailure(error: unknown) {
  if (!(error instanceof GitHubWorkEventClientError)) return false;
  const diagnostic = error.providerDiagnostic;
  return (
    error.code === 'github-notification-resource-missing' ||
    diagnostic?.classification === 'permission' ||
    (diagnostic?.classification === 'unknown' && diagnostic.httpStatus === 404)
  );
}
