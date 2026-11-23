import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { IntakeRecord } from '../../channels/github/intake/record-store.ts';
import type { OpenClawDispatchRecord } from '../tasks/dispatch/openclaw-dispatch-state.ts';
import type { DispatchRecord } from '../tasks/dispatch/codex-dispatch-state.ts';
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
