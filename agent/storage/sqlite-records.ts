import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { RecordChange, WorkflowRecords } from './workflow-records.ts';

type Database = ReturnType<typeof drizzle>;
type Use = <T>(readOnly: boolean, operation: (db: Database) => T) => Promise<T>;

function keys(table: SQLiteTable) {
  return Object.entries(getTableColumns(table)).filter(([name]) => name !== 'value');
}

function match(table: SQLiteTable, filter: object, exact: boolean) {
  const columns = keys(table);
  const fields = Object.entries(filter);
  if (exact && columns.length !== fields.length) throw new Error('incomplete storage key');
  return and(
    ...fields.map(([name, value]) => {
      const column = columns.find(([field]) => field === name)?.[1];
      if (!column || typeof value !== 'string' || !value) throw new Error('invalid storage key');
      return eq(column, value);
    }),
  );
}

export default function sqliteRecords<Records>(
  tables: Record<keyof Records, SQLiteTable>,
  use: Use,
): WorkflowRecords<Records> {
  return {
    read(query) {
      return use(true, (db) =>
        db.transaction((tx) => {
          const result = Object.entries(query).map(([name, filter]) => {
            const table = tables[name as keyof Records];
            const where = match(table, filter as object, false);
            return [
              name,
              tx
                .select()
                .from(table)
                .where(where)
                .orderBy(sql`rowid`)
                .all(),
            ];
          });
          return Object.fromEntries(result);
        }),
      );
    },
    write(changes: readonly RecordChange<Records>[]) {
      return use(false, (db) =>
        db.transaction((tx) => {
          for (const change of changes) {
            const table: SQLiteTable = tables[change.table];
            if (change.action === 'clearScope') {
              tx.delete(table)
                .where(match(table, { scope: change.scope }, false))
                .run();
            } else if (change.action === 'remove') {
              tx.delete(table)
                .where(match(table, change.key, true))
                .run();
            } else {
              const row = change.row as Record<string, unknown>;
              const { value, ...key } = row;
              match(table, key, true);
              const insert = tx.insert(table).values(row);
              if (change.action === 'insert') insert.run();
              else
                insert
                  .onConflictDoUpdate({
                    target: keys(table).map(([, column]) => column),
                    set: { value },
                  })
                  .run();
            }
          }
        }),
      );
    },
  };
}
