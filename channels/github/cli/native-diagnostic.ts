/** remediation for native backend limitations uses the existing command message section. */
export default function nativeNotificationDiagnostic(code: string): string | undefined {
  return {
    'github-notification-runtime-unsupported':
      'this workspace does not enable native openclaw notifications',
    'github-notification-workflow-unsupported':
      'this command supports the native issue planning workflow; the selected workflow is unsupported',
    'github-notification-refresh-selector-unsupported':
      'native refresh supports issue selectors; select the owning issue for linked pull-request feedback',
    'github-notification-selector-unsupported':
      'native notification observation supports issue selectors; pull-request observation is unavailable',
    'github-notification-wait-target-unsupported':
      'native openclaw notifications do not support rejection or retirement waits; choose baseline-ready, prepared, worktree-ready, or plan-ready',
    'github-notification-refresh-outcome-uncertain':
      'refresh admission is uncertain; inspect native workflow status before requesting another cycle',
    'intake-activation-required':
      'run openclaw agent-system install to activate the declared native workflow',
    'intake-policy-reconciliation-required':
      'run openclaw agent-system install to reconcile the changed native workflow policy',
  }[code];
}
