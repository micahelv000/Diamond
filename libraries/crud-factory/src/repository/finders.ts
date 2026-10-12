import { and, type SQL } from 'drizzle-orm';
import { BadRequestError } from '../errors.ts';
import type { AnyEntity, FilterOperator, FinderSuffix } from '../types.ts';
import { visibleColumns } from './projection.ts';
import { filterToSql, whereToSql } from './where.ts';

// Typed as `FinderSuffix` so these runtime names can't drift from the type-level ones.
const SUFFIX: FinderSuffix = { eq: '', in: 'In', ilike: 'Containing', gte: 'From', lte: 'Until' };

/** Builds a finder method name from a column name and an operator. */
export function finderName(column: string, operator: FilterOperator | 'between'): string {
  const suffix = operator === 'between' ? 'Between' : SUFFIX[operator];
  return `findBy${column.charAt(0).toUpperCase()}${column.slice(1)}${suffix}`;
}

/** Combines the finder's own condition with the caller's optional extra `where`. */
export type FinderWhere = (extra?: Record<string, unknown> | SQL) => SQL | undefined;

/**
 * Builds the finder methods declared by an entity's `filterable` config, for both the repository and the service.
 * Each finder passes `run` its remaining arguments and a `where` that ANDs its filter with the caller's own.
 */
export function buildFinders<Finders, Rest extends unknown[]>(
  entity: AnyEntity,
  run: (where: FinderWhere, rest: Rest) => Promise<unknown>,
): Finders {
  const { filterable = {}, primaryKey, hidden = [] } = entity.config;
  const columns = visibleColumns(entity.table, hidden);
  // `async` so an invalid value or extra `where` rejects the promise instead of throwing synchronously.
  const call = async (name: string, filter: Record<string, unknown>, rest: Rest) => {
    // `filterToSql` skips undefined values, which would drop the finder's condition and match every row.
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) throw new BadRequestError(`${name} needs a value for "${key}"`);
    }
    return run((extra) => and(filterToSql(columns, filterable, filter), whereToSql(columns, filterable, extra)), rest);
  };

  const methods: Record<string, (...args: never) => Promise<unknown>> = {};
  for (const [column, operators = []] of Object.entries(filterable)) {
    for (const operator of operators) {
      // Skipped because it would duplicate the built-in `findById`.
      if (operator === 'eq' && column === primaryKey) continue;
      const name = finderName(column, operator);
      methods[name] = (value: unknown, ...rest: Rest) => call(name, { [`${column}__${operator}`]: value }, rest);
    }
    if (operators.includes('gte') && operators.includes('lte')) {
      const name = finderName(column, 'between');
      methods[name] = (from: unknown, to: unknown, ...rest: Rest) =>
        call(name, { [`${column}__gte`]: from, [`${column}__lte`]: to }, rest);
    }
  }
  // These methods follow the same rules as the `RepositoryFinders` and `ServiceFinders` types, but
  // TypeScript can't check that for a generic entity, so the type is asserted here.
  return methods as Finders;
}
