import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const text = Type.String({ pattern: '\\S' });
const line = Type.String({ pattern: '^(?=.*\\S)[^\\r\\n]+(?![\\s\\S])' });
const closed = { additionalProperties: false };

export const structuredReportCardSchema = Type.Object(
  {
    id: text,
    format: Type.Literal('structured'),
    title: line,
    status: Type.Union([
      Type.Literal('success'),
      Type.Literal('warning'),
      Type.Literal('error'),
      Type.Literal('unknown'),
    ]),
    summary: text,
    facts: Type.Optional(Type.Array(Type.Object({ label: line, value: text }, closed))),
    findings: Type.Optional(Type.Array(text)),
    actions: Type.Optional(Type.Array(text)),
  },
  closed,
);

export const automationReportSchema = Type.Object(
  {
    schema: Type.Literal('agent-system.report'),
    version: Type.Literal(1),
    cards: Type.Array(
      Type.Union([
        structuredReportCardSchema,
        Type.Object({ id: text, format: Type.Literal('markdown'), body: text }, closed),
      ]),
      { minItems: 1 },
    ),
  },
  closed,
);

export type ReportDocument = Static<typeof automationReportSchema>;
export type StructuredReportCard = Static<typeof structuredReportCardSchema>;

// recognize only a real top-level property after syntactically complete preceding values.
// this also recognizes an explicit claim in an otherwise unfinished json document.
function claimsReport(source: string): boolean {
  let at = 0;
  const whitespace = () => {
    while (/\s/u.test(source[at] ?? '') && at < source.length) at++;
  };
  function stringEnd(start: number) {
    if (source[start] !== '"') return start;
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '"') return i + 1;
    }
    return start;
  }
  whitespace();
  if (source[at++] !== '{') return false;
  try {
    while (at < source.length) {
      whitespace();
      const end = stringEnd(at);
      if (end === at) return false;
      const key: unknown = JSON.parse(source.slice(at, end));
      at = end;
      whitespace();
      if (source[at++] !== ':') return false;
      whitespace();
      if (key === 'schema') {
        const end = stringEnd(at);
        if (end !== at && JSON.parse(source.slice(at, end)) === 'agent-system.report') return true;
      }
      const start = at;
      let depth = 0;
      for (; at < source.length; at++) {
        const char = source[at];
        if (char === '"') {
          const end = stringEnd(at);
          if (end === at) return false;
          at = end - 1;
        } else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
          if (!depth) break;
          depth--;
        } else if (char === ',' && !depth) break;
      }
      JSON.parse(source.slice(start, at));
      if (source[at++] !== ',') return false;
    }
  } catch {
    return false;
  }
  return false;
}

export type ReportClassification =
  | { kind: 'fallback' }
  | { kind: 'diagnostic'; code: string }
  | { kind: 'preferred'; document: ReportDocument };

export default function classifyAutomationReport(
  source: string,
  incomplete: boolean,
  maximumBytes: number,
): ReportClassification {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return claimsReport(source)
      ? { kind: 'diagnostic', code: incomplete ? 'report-incomplete' : 'report-json-invalid' }
      : { kind: 'fallback' };
  }
  if (!claimsReport(source)) return { kind: 'fallback' };
  if (incomplete) return { kind: 'diagnostic', code: 'report-incomplete' };
  if (Buffer.byteLength(source) > maximumBytes)
    return { kind: 'diagnostic', code: 'report-too-large' };
  if (value && typeof value === 'object' && 'version' in value && value.version !== 1)
    return { kind: 'diagnostic', code: 'report-version-unsupported' };
  if (!Value.Check(automationReportSchema, value))
    return { kind: 'diagnostic', code: 'report-schema-invalid' };
  if (new Set(value.cards.map(({ id }) => id)).size !== value.cards.length)
    return { kind: 'diagnostic', code: 'report-card-id-duplicate' };
  return { kind: 'preferred', document: value };
}
