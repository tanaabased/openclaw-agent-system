import { isDeepStrictEqual } from 'node:util';

import { Value } from 'typebox/value';

import { assessmentSummarySchema } from './assessment-summary-state.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { checkRetainedCount, packRetained, unpackRetained } from './retained-history.ts';

export function compactAssessmentSummaries(record: SharedDispatchRecord) {
  const settled =
    record.assessmentSummaries?.filter(
      (summary) =>
        summary.receipt &&
        summary.attempt &&
        summary.publicText &&
        summary.revision !== record.assessmentRevision,
    ) ?? [];
  if (!settled.length) return;
  const history = [...(record.assessmentHistory ?? [])];
  checkRetainedCount(history.length + settled.length, 'assessment-summary', record.id);
  for (const summary of settled)
    history.push({
      id: automationHash(summary),
      revision: summary.revision,
      receipt: summary.receipt!,
      evidence: packRetained(summary, record.id),
    });
  record.assessmentHistory = history;
  record.assessmentSummaries = record.assessmentSummaries!.filter(
    (summary) => !settled.includes(summary),
  );
}

export function validAssessmentHistory(record: SharedDispatchRecord) {
  const revisions = [
    ...(record.assessmentSummaries ?? []),
    ...(record.assessmentHistory ?? []),
  ].map((summary) => summary.revision);
  if (new Set(revisions).size !== revisions.length) return false;
  return (record.assessmentHistory ?? []).every((entry) => {
    const summary = unpackRetained(entry.evidence);
    return (
      Value.Check(assessmentSummarySchema, summary) &&
      Boolean(summary.attempt && summary.publicText) &&
      entry.id === automationHash(summary) &&
      entry.revision === summary.revision &&
      isDeepStrictEqual(entry.receipt, summary.receipt)
    );
  });
}
