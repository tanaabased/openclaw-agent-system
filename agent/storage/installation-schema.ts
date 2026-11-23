import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type {
  AssignmentClaimRecord,
  AssignmentClaimState,
} from '../tasks/dispatch/assignment-claim-store.ts';
import type { PickupEnrollment } from '../issue-pickup-enrollment.ts';
import type { SidebarState } from '../codex-sidebar-journal.ts';
import type { RepositoryRecord } from '../../tools/git/repository-service.ts';

export const instances = sqliteTable(
  'instances',
  {
    id: text().notNull(),
    value: text({ mode: 'json' }).$type<Omit<AssignmentClaimState, 'claims'>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);
export const assignmentClaims = sqliteTable(
  'assignment_claims',
  {
    id: text().notNull(),
    value: text({ mode: 'json' }).$type<AssignmentClaimRecord>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
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
export const sidebarPlacements = sqliteTable(
  'sidebar_placements',
  {
    scope: text().notNull(),
    value: text({ mode: 'json' }).$type<SidebarState>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope] })],
);
export const managedRepositories = sqliteTable(
  'managed_repositories',
  {
    root: text().notNull(),
    id: text().notNull(),
    value: text({ mode: 'json' }).$type<RepositoryRecord>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.root, t.id] })],
);
