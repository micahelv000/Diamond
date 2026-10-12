import { getColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { buildSchemas } from './schemas.ts';
import type { ColumnKey, Entity, EntityConfig, FilterOperator } from './types.ts';

const FILTER_OPERATORS: readonly FilterOperator[] = ['eq', 'in', 'ilike', 'gte', 'lte'];
// drizzle types some non-text columns as strings too, but Postgres `ilike` only works on text types.
const TEXT_COLUMN_TYPES = new Set(['PgText', 'PgVarchar', 'PgChar']);

type KeysOf<V> = V extends readonly (infer K extends string)[] ? K : never;
type HiddenOf<C> = C extends { hidden: infer H } ? KeysOf<H> : never;
type VisibleSpec<T extends PgTable, C> = Exclude<ColumnKey<T>, HiddenOf<C>> | `-${Exclude<ColumnKey<T>, HiddenOf<C>>}`;

// Intersected with the config so a failed check reports the error on the offending key. A plain
// conditional would break inference in nested calls, and a conflicting literal would collapse the
// config to `never`, so failures add an object type that lists the allowed values.
type ConfigChecks<T extends PgTable, C> = (C extends { defaultSort: infer D }
  ? D extends VisibleSpec<T, C>
    ? unknown
    : { defaultSort: { 'must be one of': VisibleSpec<T, C> } }
  : unknown) & {
  filterable?: { [K in HiddenOf<C>]?: never };
  sortable?: readonly Exclude<KeysOf<C extends { sortable: infer S } ? S : never>, HiddenOf<C>>[];
};

function assertColumns(tableName: string, columnKeys: Set<string>, option: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!columnKeys.has(key)) throw new Error(`${tableName}: ${option} references unknown column "${key}"`);
  }
}

// The types already reject bad keys; this catches configs built from untyped data or casts.
function validateConfig(tableName: string, table: PgTable, config: EntityConfig<PgTable>): void {
  const columns = getColumns(table);
  const columnKeys = new Set(Object.keys(columns));
  const check = (option: string, keys: readonly string[]) => assertColumns(tableName, columnKeys, option, keys);
  const filterable = Object.entries(config.filterable ?? {});
  const sortKey = config.defaultSort?.replace(/^-/, '');

  check('primaryKey', [config.primaryKey]);
  check('hidden', config.hidden ?? []);
  check('create.omit', config.create?.omit ?? []);
  check('update.omit', config.update?.omit ?? []);
  check('filterable', filterable.map(([key]) => key));
  check('sortable', config.sortable ?? []);
  check('softDelete', config.softDelete ? [config.softDelete] : []);
  check('defaultSort', sortKey === undefined ? [] : [sortKey]);

  const hidden = new Set<string>(config.hidden ?? []);
  if (hidden.has(config.primaryKey)) throw new Error(`${tableName}: the primary key cannot be hidden`);
  // Filtering or sorting on a hidden column would leak its value through query results.
  for (const key of [...filterable.map(([column]) => column), ...(config.sortable ?? []), sortKey]) {
    if (key !== undefined && hidden.has(key)) {
      throw new Error(`${tableName}: hidden column "${key}" cannot be filterable or sortable`);
    }
  }
  for (const [key, operators = []] of filterable) {
    const unknown = operators.find((operator) => !FILTER_OPERATORS.includes(operator));
    if (unknown !== undefined) throw new Error(`${tableName}: filterable.${key} has unknown operator "${unknown}"`);
    const column = columns[key];
    if (operators.includes('ilike') && !(column && TEXT_COLUMN_TYPES.has(column.columnType) && column.dimensions === 0)) {
      throw new Error(`${tableName}: filterable.${key} uses ilike, which needs a text column`);
    }
  }
  const softDeleteColumn = config.softDelete ? columns[config.softDelete] : undefined;
  if (softDeleteColumn?.notNull) throw new Error(`${tableName}: softDelete column must be nullable`);
  if (softDeleteColumn && !softDeleteColumn.getSQLType().startsWith('timestamp')) {
    throw new Error(`${tableName}: softDelete column must be a timestamp`);
  }
  for (const [option, limit] of Object.entries(config.pagination ?? {})) {
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
      throw new Error(`${tableName}: pagination.${option} must be a positive integer`);
    }
  }
}

// `EntityConfig<T> &` adds no constraint; it makes hovers on config fields show their docs.
/** Declares a CRUD entity for a table, validates its config at load time and derives its Zod schemas. */
export function defineEntity<T extends PgTable, const C extends EntityConfig<T>>(table: T, config: EntityConfig<T> & C & ConfigChecks<T, C>): Entity<T, C> {
  const name = getTableName(table);
  // `EntityConfig<T>` only narrows key types, so it is safe to use as `EntityConfig<PgTable>`.
  const runtimeConfig: EntityConfig<PgTable> = config;
  validateConfig(name, table, runtimeConfig);

  const hidden = new Set<string>(runtimeConfig.hidden ?? []);
  const visibleKeys = Object.keys(getColumns(table)).filter((key) => !hidden.has(key));
  const [first, ...rest] = visibleKeys;
  if (first === undefined) throw new Error(`${name}: every column is hidden`);

  return { name, table, config, schemas: buildSchemas(table, runtimeConfig, [first, ...rest]) };
}
