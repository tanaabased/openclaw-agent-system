import githubNotificationCard, {
  githubNotificationMarkdownText,
  githubNotificationSeparatedMessage,
} from './card.ts';

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
    return githubNotificationSeparatedMessage(
      `[@${senderLabel}](${projection.sender.url}) · [${itemLabel}](${projection.item.url})`,
      `assigned you to ${itemLabel}.${note ? ' ' + note : ''}`,
    );
  }

  return githubNotificationCard({
    emoji: projection.emoji,
    title: projection.item.kind + ' requested',
    summary:
      'You requested [' + itemLabel + '](' + projection.item.url + ').' + (note ? ' ' + note : ''),
  });
}
