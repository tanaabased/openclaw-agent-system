import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { AutomationReportRecord } from '../automations/automation-report-store.ts';
import type { AutomationRecord } from '../automations/automation-store.ts';
import type { ThreadRecord } from '../automations/automation-threads.ts';
import type { Ledger as CodexAutomationLedger } from '../automations/codex-automation-snapshot.ts';
import type { PickupEnrollment } from '../issue-pickup-enrollment.ts';
import type { NotificationResetRecord } from '../notification-reset-state.ts';
import type { ImplementationEntry } from '../tasks/implementation/implementation-entry-state.ts';
import type { NativeRetirementEntry } from '../tasks/retirement/native-retirement.ts';
import type { GitHubIdentity } from '../../channels/github/provider/work-item.ts';
import type { StoredPathProjection } from '../../paths/projection-store.ts';
import type { IntakeRecord, IntakeState } from '../../channels/github/intake/record-store.ts';
import type { OpenClawDispatchRecord } from '../tasks/dispatch/openclaw-dispatch-state.ts';
import type { DispatchRecord, DispatchState } from '../tasks/dispatch/codex-dispatch-state.ts';
import type { ReplyDraft } from '../tasks/feedback/reply-store.ts';

/** Keep each workflow's existing scope, logical id and validated record value. */
function recordColumns<Value>() {
  return {
    scope: text().notNull(),
    id: text().notNull(),
    value: text({ mode: 'json' }).$type<Value>().notNull(),
  };
}

export const intakeRecords = sqliteTable(
  'intake_records',
  recordColumns<IntakeRecord>(),
  (table) => [primaryKey({ columns: [table.scope, table.id] })],
);
export const dispatchRecords = sqliteTable(
  'dispatch_records',
  recordColumns<DispatchRecord | OpenClawDispatchRecord>(),
  (table) => [primaryKey({ columns: [table.scope, table.id] })],
);
export const replyDrafts = sqliteTable('reply_drafts', recordColumns<ReplyDraft>(), (table) => [
  primaryKey({ columns: [table.scope, table.id] }),
]);

function scopedState<Value>(name: string) {
  return sqliteTable(
    name,
    {
      scope: text().notNull(),
      value: text({ mode: 'json' }).$type<Value>().notNull(),
    },
    (table) => [primaryKey({ columns: [table.scope] })],
  );
}

function scopedRecords<Value>(name: string) {
  return sqliteTable(name, recordColumns<Value>(), (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
  ]);
}

export const intakeState = scopedState<Omit<IntakeState, 'records'>>('intake_state');
export const dispatchState =
  scopedState<Omit<DispatchState, 'records' | 'isolatedRecords'>>('dispatch_state');
export const notificationResets = scopedState<NotificationResetRecord>('notification_resets');
export const githubIdentityPins = scopedRecords<GitHubIdentity>('github_identity_pins');
export const directEntries = sqliteTable(
  'direct_entries',
  {
    ...recordColumns<ImplementationEntry | NativeRetirementEntry>(),
    kind: text({ enum: ['implementation', 'native-retirement'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.kind, t.id] })],
);
export const pickupEnrollments = sqliteTable(
  'pickup_enrollments',
  {
    runtime: text({ enum: ['openclaw', 'codex'] }).notNull(),
    scope: text().notNull(),
    value: text({ mode: 'json' }).$type<PickupEnrollment>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runtime, t.scope] })],
);
export const automationRegistrations = scopedRecords<
  AutomationRecord | CodexAutomationLedger['records'][number]
>('automation_registrations');
export const automationState =
  scopedState<Omit<CodexAutomationLedger, 'records'>>('automation_state');
export const automationThreads = scopedRecords<ThreadRecord>('automation_threads');
export const automationReports = sqliteTable(
  'automation_reports',
  {
    executionId: text('execution_id').notNull(),
    value: text({ mode: 'json' }).$type<AutomationReportRecord>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.executionId] })],
);
export const pathProjections = scopedState<StoredPathProjection>('path_projections');
