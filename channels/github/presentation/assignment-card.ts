import githubNotificationCard, {
  githubNotificationAttributedMessage,
  githubNotificationMarkdownText,
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
  const item = `[${githubNotificationMarkdownText(projection.item.label)}](${projection.item.url})`;
  const sender = projection.sender
    ? `[@${githubNotificationMarkdownText(projection.sender.label)}](${projection.sender.url})`
    : undefined;
  const summary = sender
    ? `${sender} assigned you to ${item}.${note ? ' ' + note : ''}`
    : `You requested ${item}.${note ? ' ' + note : ''}`;
  if (sender)
    return githubNotificationAttributedMessage(
      `${sender} · [${githubNotificationMarkdownText(projection.item.label)} ↗](${projection.item.url})`,
      summary,
    );
  return githubNotificationCard({
    emoji: projection.emoji,
    title: projection.item.kind + ' requested',
    summary,
  });
}
