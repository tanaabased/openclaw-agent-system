import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

/** presentation only; the owning runtime supplies the authorized action. */
export default function assignmentCard(
  projection: {
    emoji: string;
    item: { kind: string; label: string; url: string };
    sender?: { label: string; url: string };
  },
  note = '',
) {
  const itemLabel = githubNotificationMarkdownText(projection.item.label);
  if (projection.sender) {
    const senderLabel = githubNotificationMarkdownText(projection.sender.label);
    return githubNotificationCard(
      {
        emoji: projection.emoji,
        title: projection.item.kind + ' assigned',
        summary:
          `[@${senderLabel}](${projection.sender.url}) assigned you to ` +
          `[${itemLabel}](${projection.item.url}).` +
          (note ? ' ' + note : ''),
      },
      { quoted: false },
    );
  }

  return githubNotificationCard({
    emoji: projection.emoji,
    title: projection.item.kind + ' requested',
    summary:
      'You requested [' + itemLabel + '](' + projection.item.url + ').' + (note ? ' ' + note : ''),
  });
}
