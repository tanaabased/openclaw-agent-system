/** detect private candidate content without importing or reading openclaw configuration. */
export default function redactCodexFeedback(text: string): string {
  const privateContent =
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+|\bBearer\s+\S+|https?:\/\/[^\s/]+:[^\s/]+@|[?&](?:token|key|secret|password)=[^\s&#]+)/iu;
  return privateContent.test(text) ? '[private content withheld]' : text;
}
