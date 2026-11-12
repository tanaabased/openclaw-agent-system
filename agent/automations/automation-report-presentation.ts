import { stripVTControlCharacters } from 'node:util';

import redactFeedback from '../tasks/feedback/feedback-redaction.ts';
import type { StructuredReportCard } from './automation-report-schema.ts';

export function sanitizeReportText(text: string): string {
  return redactFeedback(
    stripVTControlCharacters(text)
      // eslint-disable-next-line no-control-regex -- remove terminal and bidi control bytes
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')
      .replace(/\b(?:gh[pousr]_|github_pat_|ops_|opsa_)[A-Za-z0-9_]+/gu, '[redacted]'),
  );
}

function plain(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_{}[\]()#+|~])/gu, '\\$1')
    .replace(/^(\s*)-(?=\s)/gmu, '$1\\-');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

export const reportStatusIcons = { success: '✅', warning: '⚠️', error: '❌', unknown: '⚠️' };
export const reportSections = {
  facts: 'Facts',
  findings: 'Findings',
  actions: 'Suggested next actions',
};

export function renderStructuredReport(card: StructuredReportCard): string {
  const chunks = [`## ${reportStatusIcons[card.status]} ${plain(card.title)}`, plain(card.summary)];
  if (card.facts?.length)
    chunks.push(
      `**${reportSections.facts}**\n${card.facts.map(({ label, value }) => `- **${plain(label)}:** ${plain(value)}`).join('\n')}`,
    );
  for (const key of ['findings', 'actions'] as const)
    if (card[key]?.length)
      chunks.push(
        `**${reportSections[key]}**\n${card[key].map((value) => `- ${plain(value)}`).join('\n')}`,
      );
  return quote(chunks.join('\n\n'));
}

export function reportDiagnosticBlock(text: string): string {
  const fence = '`'.repeat(
    Math.max(3, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length + 1)),
  );
  return `${fence}text\n${text}\n${fence}`;
}

export function standardReportInstructions(): string {
  return [
    'Use this standard Markdown card template, replacing sample values with evidence-backed content. Omit optional sections without useful evidence; do not invent facts or actions.',
    renderStructuredReport({
      id: 'example',
      format: 'structured',
      title: 'Automation name and outcome',
      status: 'success',
      summary: 'What happened and what it means.',
      facts: [{ label: 'Source', value: 'Reported fact' }],
      findings: ['Evidence-backed finding'],
      actions: ['Justified suggested next action'],
    }),
    `Use only these optional section headings: ${Object.values(reportSections).join(', ')}. Quote each card line once, including blank lines and diagnostic fences.`,
  ].join('\n');
}
