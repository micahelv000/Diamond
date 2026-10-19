import { asc, desc, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { BadRequestError } from '../errors.ts';
import type { ColumnMap } from './visible-columns.ts';

/** One ORDER BY column: its key, its drizzle column and its direction. */
export interface SortKey {
  key: string;
  column: PgColumn;
  descending: boolean;
}

/**
 * Resolves `key` or `-key` specs into sort keys, always ending with the primary key so paging is stable.
 * Only the given visible columns are accepted, so hidden columns can't be sorted on.
 */
export function sortKeys(columns: ColumnMap, specs: readonly string[], primaryKey: string): SortKey[] {
  const keys: SortKey[] = [];
  for (const spec of specs) {
    const descending = spec.startsWith('-');
    const key = descending ? spec.slice(1) : spec;
    const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
    if (!column) throw new BadRequestError(`Cannot sort by "${key}"`);
    keys.push({ key, column, descending });
  }
  const primaryColumn = columns[primaryKey];
  const primaryKeySorted = keys.some((sortKey) => sortKey.key === primaryKey);
  if (primaryColumn && !primaryKeySorted) {
    keys.push({ key: primaryKey, column: primaryColumn, descending: false });
  }
  return keys;
}

/** Turns sort keys into ORDER BY clauses. */
export function orderBy(keys: readonly SortKey[]): SQL[] {
  return keys.map(({ column, descending }) => (descending ? desc(column) : asc(column)));
}
