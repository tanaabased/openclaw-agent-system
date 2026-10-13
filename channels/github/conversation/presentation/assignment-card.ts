import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

/** presentation only; the owning runtime supplies the authorized action. */
export default function assignmentCard(
  projection: {
    emoji: string;
    item: { kind: string; label: string; url: string };
    sender: { label: string; url: string };
  },
  action: string,
) {
  return githubNotificationCard({
    emoji: projection.emoji,
    title: projection.item.kind + ' assigned',
    summary:
      '[@' +
      githubNotificationMarkdownText(projection.sender.label) +
      '](' +
      projection.sender.url +
      ') assigned you to [' +
      githubNotificationMarkdownText(projection.item.label) +
      '](' +
      projection.item.url +
      '). ' +
      action,
  });
}
