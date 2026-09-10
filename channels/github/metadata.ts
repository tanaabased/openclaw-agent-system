import { githubNotificationChannelId } from './routing/routing.ts';

/** Static GitHub notification channel metadata shared with package-time discovery. */
export const githubNotificationChannelMetadata = {
  id: githubNotificationChannelId,
  label: 'Agent System GitHub Notifications',
  selectionLabel: 'Agent System GitHub Notifications',
  detailLabel: 'GitHub Notifications',
  docsPath:
    'https://github.com/tanaabased/openclaw-agent-system/blob/main/channels/github/README.md',
  docsLabel: 'GitHub notifications',
  blurb:
    'Admits authorized GitHub assignments and relays approved issue and linked delivery pull-request comments.',
  systemImage: 'bell.badge',
  markdownCapable: true,
  exposure: { configured: true, docs: true, setup: false },
  forceAccountBinding: true,
} as const;
