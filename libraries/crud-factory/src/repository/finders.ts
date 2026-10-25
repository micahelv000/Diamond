import { and, type SQL } from 'drizzle-orm';
import { BadRequestError } from '../errors.ts';
import type { AnyEntity, FilterOperator, FinderSuffix } from '../types.ts';
import { visibleColumns } from './visible-columns.ts';
import { filterToSql, whereToSql } from './utils.ts';

// Typed as `FinderSuffix` so these runtime names can't drift from the type-level ones.
const SUFFIX: FinderSuffix = { eq: '', in: 'In', ilike: 'Containing', gte: 'From', lte: 'Until' };

/** Builds a finder method name from a column name and an operator. */
function finderName(column: string, operator: FilterOperator | 'between'): string {
  const suffix = operator === 'between' ? 'Between' : SUFFIX[operator];
  return `findBy${column.charAt(0).toUpperCase()}${column.slice(1)}${suffix}`;
}

/** One generated finder, before the repository or the service turns it into a method. */
export interface FinderSpec {
  /** The method name, such as `findByEmail` or `findByCreatedAtBetween`. */
  name: string;
  /** How many values come before the other arguments: two for a Between finder, one otherwise. */
  valueCount: 1 | 2;
  /** The finder's condition ANDed with the caller's extra `where`. Throws `BadRequestError` for an `undefined` value. */
  toWhere(values: readonly unknown[], extra: Record<string, unknown> | SQL | undefined): SQL | undefined;
}

/** The finder methods a layer builds from the specs, before they are typed. */
export type FinderMethods = Record<string, (...args: never) => Promise<unknown>>;

/** Lists the finders declared by an entity's `filterable` config. */
export function buildFinders(entity: AnyEntity): FinderSpec[] {
  const { filterable = {}, primaryKey, hidden = [] } = entity.config;
  const columns = visibleColumns(entity.table, hidden);

  // `filterKeys` holds one filter key per value, in the order the method takes the values.
  const spec = (name: string, filterKeys: readonly [string] | readonly [string, string]): FinderSpec => ({
    name,
    valueCount: filterKeys.length,
    toWhere: (values, extra) => {
      const filter: Record<string, unknown> = {};
      for (const [index, key] of filterKeys.entries()) {
        const value = values[index];
        // `filterToSql` skips undefined values, which would drop the finder's condition and match every row.
        if (value === undefined) throw new BadRequestError(`${name} needs a value for "${key}"`);
        filter[key] = value;
      }
      return and(filterToSql(columns, filterable, filter), whereToSql(columns, filterable, extra));
    },
  });

  const specs: FinderSpec[] = [];
  for (const [column, operators = []] of Object.entries(filterable)) {
    for (const operator of operators) {
      // Skipped because it would duplicate the built-in `findById`.
      if (operator === 'eq' && column === primaryKey) continue;
      specs.push(spec(finderName(column, operator), [`${column}__${operator}`]));
    }
    if (operators.includes('gte') && operators.includes('lte')) {
      specs.push(spec(finderName(column, 'between'), [`${column}__gte`, `${column}__lte`]));
    }
  }
  return specs;
}

/**
 * Types the finder methods a layer built. They follow the same rules as the `RepositoryFinders` and
 * `ServiceFinders` types, but TypeScript can't check that for a generic entity, so the type is asserted here.
 */
export function typedFinders<Finders>(methods: FinderMethods): Finders {
  return methods as Finders;
}
