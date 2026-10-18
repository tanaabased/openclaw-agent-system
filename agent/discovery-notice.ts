import { githubNotificationQuote } from '../channels/github/presentation/card.ts';

/** report transitions once; counts describe known sources, never an invented percentage. */
export default function discoveryNotice(progress?: {
  pending: boolean;
  reported?: boolean;
  sources: number;
}) {
  if (!progress || progress.reported === progress.pending) return undefined;
  return githubNotificationQuote(
    progress.pending
      ? `## ℹ️ Intake discovery continues\n\nProgress is saved. Remaining issue and feedback checks will continue on the next scheduled run. Available work can proceed.\n\n**Conversations monitored:** ${progress.sources}`
      : '## ℹ️ Intake discovery caught up\n\nThe pending discovery pass is complete. Normal monitoring continues.',
  );
}
