import type * as agent from './schema.ts';
import type * as installation from './installation-schema.ts';

type Rows<Tables> = {
  [Name in keyof Tables]: Tables[Name] extends { $inferSelect: infer Row } ? Row : never;
};
export type AgentRows = Rows<typeof agent>;
export type InstallationRows = Rows<typeof installation>;

type Keys<Row> = Omit<Row, 'value' | 'state' | 'completedAt'>;
export type Selection<Records> = {
  [Name in keyof Records]?: Partial<Keys<Records[Name]>>;
};
export type RecordChange<Records> = {
  [Name in keyof Records]:
    | { table: Name; action: 'insert' | 'save'; row: Records[Name] }
    | { table: Name; action: 'remove'; key: Keys<Records[Name]> }
    | (Records[Name] extends { scope: string }
        ? { table: Name; action: 'clearScope'; scope: string }
        : never);
}[keyof Records];

/** Read related records together and commit related changes in a single transaction. */
export interface WorkflowRecords<Records> {
  read<Query extends Selection<Records>>(
    query: Query,
  ): Promise<{ [Name in keyof Query & keyof Records]: Records[Name][] }>;
  write(changes: readonly RecordChange<Records>[]): Promise<void>;
}
