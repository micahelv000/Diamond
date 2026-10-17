import { getColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

export type ColumnMap = Record<string, PgColumn>;

/** All columns of the table except the hidden ones. */
export function visibleColumns(table: PgTable, hidden: readonly string[]): ColumnMap {
  const columns: ColumnMap = getColumns(table);
  return Object.fromEntries(Object.entries(columns).filter(([key]) => !hidden.includes(key)));
}

/** Limits the visible columns to `keys`, or returns all of them when no keys are given. Unknown or hidden keys are ignored. */
export function selection(visible: ColumnMap, keys?: readonly string[]): ColumnMap {
  if (!keys || keys.length === 0) return visible;
  return Object.fromEntries(Object.entries(visible).filter(([key]) => keys.includes(key)));
}

/** Copies only the given keys of a row. */
export function pickFields(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = row[key];
  return picked;
}

/**
 * Types a column map as the table's own column objects.
 * The cast is safe because every value came from `getColumns(table)` under the same key.
 */
export function typedColumns<Selected>(map: ColumnMap): Selected {
  return map as Selected;
}

/**
 * Attaches the row type to query results. Drizzle can't infer it through a generic table, but each
 * row has exactly the selected columns with their column types.
 */
export function typedRows<Row>(rows: readonly Record<string, unknown>[]): Row[] {
  return rows as Row[];
}
