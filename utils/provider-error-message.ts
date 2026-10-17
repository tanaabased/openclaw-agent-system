/** Bound provider prose and remove credentials before it enters retained diagnostics. */
export default function providerErrorMessage(value: unknown, secrets: readonly string[] = []) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let text = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const representation of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ])
      text = text.split(representation).join('[redacted]');
  }
  text = text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      '[redacted]',
    )
    .replace(
      /(?:authorization|proxy-authorization|cookie|set-cookie)\s*["']?\s*[:=][^\r\n]*/giu,
      '[redacted]',
    )
    .replace(/\b(?:ops_|opsa_)[^\s"',;]+/gu, '[redacted]')
    .replace(/\b(?:request|response)?[ _-]?(?:body|headers)\s*["']?\s*[:=][\s\S]*/giu, '[redacted]')
    .replace(/\bBearer\s+[^\s"',;}]+/giu, '[redacted]')
    .replace(/(?:op|https?):\/\/[^\s<>"']+/giu, '[redacted]')
    .replace(
      /\b(?:(?:(?:access|refresh|service[_-]?account)[_-]?)?token|(?:client[_-]?)?secret|api[_-]?key|password|credential|value|body|headers)(?:[A-Za-z_-]*)\s*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/giu,
      '[redacted]',
    )
    .replace(/\p{Cc}|\p{Cf}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > 1024 ? `${text.slice(0, 1024)}…` : text || undefined;
}
