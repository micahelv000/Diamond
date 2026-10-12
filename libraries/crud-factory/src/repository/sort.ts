import { asc, desc, type SQL } from 'drizzle-orm';
import { BadRequestError } from '../errors.ts';
import type { ColumnMap } from './projection.ts';

/**
 * Builds ORDER BY clauses from `key` or `-key` specs, always ending with the primary key so paging is stable.
 * Only the given visible columns are accepted, so hidden columns can't be sorted on.
 */
export function orderBy(columns: ColumnMap, specs: readonly string[], primaryKey: string): SQL[] {
  const clauses: SQL[] = [];
  let sortsByPrimaryKey = false;
  for (const spec of specs) {
    const descending = spec.startsWith('-');
    const key = descending ? spec.slice(1) : spec;
    const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
    if (!column) throw new BadRequestError(`Cannot sort by "${key}"`);
    clauses.push(descending ? desc(column) : asc(column));
    sortsByPrimaryKey ||= key === primaryKey;
  }
  const primaryColumn = columns[primaryKey];
  if (!sortsByPrimaryKey && primaryColumn) clauses.push(asc(primaryColumn));
  return clauses;
}
