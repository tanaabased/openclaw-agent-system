/** distinguish initial setup from updates without changing the intake gate. */
export default function intakeAutomationNotice(code: string, automationId?: string) {
  if (code === 'intake-automation-update-required')
    return {
      severity: 'warning' as const,
      emoji: '✨',
      title: 'Update available',
      summary: automationId
        ? `Unapplied changes for automation ${automationId} were detected in agent configuration. This run used the previous version of its configuration.`
        : 'Your intake automation needs an update. New intake is paused until it’s applied. Existing chats and work are retained.',
      next: automationId
        ? 'Run Agent System Install to apply pending changes.'
        : 'Run Agent System Install to apply the update and resume intake.',
    };
  if (code === 'intake-activation-required')
    return {
      severity: 'warning' as const,
      emoji: '⚠️',
      title: 'Set up intake automation',
      summary: 'Your intake automation has not been activated. New intake will start after setup.',
      next: 'Run Agent System Install to activate intake.',
    };
  return undefined;
}
