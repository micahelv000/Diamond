import { and, eq, gte, ilike, inArray, is, isNull, lte, SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { BadRequestError } from '../errors.ts';
import type { EntityConfig, FilterOperator } from '../types.ts';

type Columns = Record<string, PgColumn>;
type FilterableConfig = NonNullable<EntityConfig<PgTable>['filterable']>;

function operatorSql(column: PgColumn, operator: FilterOperator, value: unknown): SQL {
  switch (operator) {
    case 'eq':
      return value === null ? isNull(column) : eq(column, value);
    case 'in':
      if (!Array.isArray(value)) throw new BadRequestError(`"${column.name}__in" expects an array`);
      return inArray(column, value);
    case 'ilike':
      // Escape wildcards so the filter means "contains" and user input can't act as a pattern.
      return ilike(column, `%${String(value).replace(/[\\%_]/g, '\\$&')}%`);
    case 'gte':
      return gte(column, value);
    case 'lte':
      return lte(column, value);
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function parseFilterKey(key: string): { column: string; operator: string } {
  const separator = key.lastIndexOf('__');
  if (separator <= 0) return { column: key, operator: '' };
  return { column: key.slice(0, separator), operator: key.slice(separator + 2) };
}

/** Converts a `field__op` filter object into SQL. Throws `BadRequestError` for keys the entity doesn't allow. */
export function filterToSql(columns: Columns, filterable: FilterableConfig, filter: Record<string, unknown>): SQL | undefined {
  const conditions: SQL[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    const { column, operator } = parseFilterKey(key);
    const allowed: readonly FilterOperator[] = filterable[column] ?? [];
    const allowedOperator = allowed.find((candidate) => candidate === operator);
    const target = columns[column];
    if (!allowedOperator || !target) throw new BadRequestError(`Filter "${key}" is not allowed`);
    conditions.push(operatorSql(target, allowedOperator, value));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Converts a `where` value, either a typed filter object or a raw `SQL` chunk, into SQL. */
export function whereToSql(
  columns: Columns,
  filterable: FilterableConfig,
  where: SQL | Record<string, unknown> | undefined,
): SQL | undefined {
  if (where === undefined) return undefined;
  return is(where, SQL) ? where : filterToSql(columns, filterable, where);
}
