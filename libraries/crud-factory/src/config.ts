import { getColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { buildSchemas } from './schemas.ts';
import type { ArrayItem, ColumnKey, Entity, EntityConfig, FilterOperator, HiddenKey, SortSpec } from './types.ts';

const FILTER_OPERATORS: readonly FilterOperator[] = ['eq', 'in', 'ilike', 'gte', 'lte'];
// drizzle types some non-text columns as strings too, but Postgres `ilike` only works on text types.
const TEXT_COLUMN_TYPES = new Set(['PgText', 'PgVarchar', 'PgChar']);

type Hidden<T extends PgTable, C extends EntityConfig<T>> = HiddenKey<Entity<T, C>>;
type VisibleSpec<T extends PgTable, C extends EntityConfig<T>> = SortSpec<Entity<T, C>>;

// Each check below is intersected with the config, so a failed check reports the error on the
// offending key. A plain conditional would break inference in nested calls, and a conflicting
// literal would collapse the config to `never`, so a failure adds an object type that lists the
// allowed values instead.

/** `defaultSort`, when set, must name a visible column. `C['defaultSort']` can't be used: it is `unknown` when the key is absent. */
type DefaultSortCheck<T extends PgTable, C extends EntityConfig<T>> = C extends { defaultSort: infer D }
  ? D extends VisibleSpec<T, C>
    ? unknown
    : { defaultSort: { 'must be one of': VisibleSpec<T, C> } }
  : unknown;

/** Hidden columns can't be filterable. */
interface NoHiddenFilters<T extends PgTable, C extends EntityConfig<T>> {
  filterable?: { [K in Hidden<T, C>]?: never };
}

/** Hidden columns can't be sortable. */
interface NoHiddenSorts<T extends PgTable, C extends EntityConfig<T>> {
  sortable?: readonly Exclude<ArrayItem<C['sortable']>, Hidden<T, C>>[];
}

/**
 * Soft delete is on by default and uses `deletedAt`. A table without that column must say which column to use,
 * or `softDelete: false`, so rows are never hard-deleted by accident.
 */
type SoftDeleteCheck<T extends PgTable, C extends EntityConfig<T>> = C extends { softDelete: unknown }
  ? unknown
  : 'deletedAt' extends ColumnKey<T>
    ? unknown
    : { softDelete: ColumnKey<T> | false };

type ConfigChecks<T extends PgTable, C extends EntityConfig<T>> = DefaultSortCheck<T, C> &
  NoHiddenFilters<T, C> &
  NoHiddenSorts<T, C> &
  SoftDeleteCheck<T, C>;

const DEFAULT_SOFT_DELETE_COLUMN = 'deletedAt';

/** The soft delete column: the one named in the config, `deletedAt` when none is named, or `undefined` with `false`. */
export function softDeleteKey(config: EntityConfig<PgTable>): string | undefined {
  if (config.softDelete === false) return undefined;
  return config.softDelete ?? DEFAULT_SOFT_DELETE_COLUMN;
}

/** Columns never sent to clients or accepted from them: the hidden ones and the soft delete column. */
export function serverOnlyKeys(config: EntityConfig<PgTable>): string[] {
  const hidden = config.hidden ?? [];
  const softDelete = softDeleteKey(config);
  return softDelete === undefined ? [...hidden] : [...hidden, softDelete];
}

/** The `defaultSort` column without its leading `-`. */
function defaultSortKey(config: EntityConfig<PgTable>): string | undefined {
  return config.defaultSort?.replace(/^-/, '');
}

function assertKnownColumns(tableName: string, columns: Record<string, PgColumn>, config: EntityConfig<PgTable>): void {
  const columnKeys = new Set(Object.keys(columns));
  const check = (option: string, keys: readonly string[]) => {
    for (const key of keys) {
      if (!columnKeys.has(key)) throw new Error(`${tableName}: ${option} references unknown column "${key}"`);
    }
  };
  const sortKey = defaultSortKey(config);

  check('primaryKey', [config.primaryKey]);
  check('hidden', config.hidden ?? []);
  check('create.omit', config.create?.omit ?? []);
  check('update.omit', config.update?.omit ?? []);
  check('filterable', Object.keys(config.filterable ?? {}));
  check('sortable', config.sortable ?? []);
  if (typeof config.softDelete === 'string') check('softDelete', [config.softDelete]);
  check('defaultSort', sortKey === undefined ? [] : [sortKey]);
}

// Filtering or sorting on a hidden column would leak its value through query results.
function assertNoHiddenInQueries(tableName: string, config: EntityConfig<PgTable>): void {
  const hidden = new Set<string>(config.hidden ?? []);
  if (hidden.has(config.primaryKey)) throw new Error(`${tableName}: the primary key cannot be hidden`);
  for (const key of [...Object.keys(config.filterable ?? {}), ...(config.sortable ?? []), defaultSortKey(config)]) {
    if (key !== undefined && hidden.has(key)) {
      throw new Error(`${tableName}: hidden column "${key}" cannot be filterable or sortable`);
    }
  }
}

function isTextColumn(column: PgColumn | undefined): boolean {
  return column !== undefined && TEXT_COLUMN_TYPES.has(column.columnType) && column.dimensions === 0;
}

function assertOperators(tableName: string, columns: Record<string, PgColumn>, config: EntityConfig<PgTable>): void {
  for (const [key, operators = []] of Object.entries(config.filterable ?? {})) {
    const unknown = operators.find((operator) => !FILTER_OPERATORS.includes(operator));
    if (unknown !== undefined) throw new Error(`${tableName}: filterable.${key} has unknown operator "${unknown}"`);
    if (operators.includes('ilike') && !isTextColumn(columns[key])) {
      throw new Error(`${tableName}: filterable.${key} uses ilike, which needs a text column`);
    }
  }
}

function assertSoftDelete(tableName: string, columns: Record<string, PgColumn>, config: EntityConfig<PgTable>): void {
  const key = softDeleteKey(config);
  if (key === undefined) return;
  const column = columns[key];
  if (!column) {
    throw new Error(
      `${tableName}: soft delete is on by default and needs a "${DEFAULT_SOFT_DELETE_COLUMN}" column. ` +
        'Add one, name another column with softDelete, or set softDelete: false',
    );
  }
  if (column.notNull) throw new Error(`${tableName}: softDelete column must be nullable`);
  if (!column.getSQLType().startsWith('timestamp')) throw new Error(`${tableName}: softDelete column must be a timestamp`);
}

function assertPagination(tableName: string, config: EntityConfig<PgTable>): void {
  for (const [option, limit] of Object.entries(config.pagination ?? {})) {
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
      throw new Error(`${tableName}: pagination.${option} must be a positive integer`);
    }
  }
}

// The types already reject bad keys; this catches configs built from untyped data or casts.
function validateConfig(tableName: string, table: PgTable, config: EntityConfig<PgTable>): void {
  const columns = getColumns(table);
  assertKnownColumns(tableName, columns, config);
  assertNoHiddenInQueries(tableName, config);
  assertOperators(tableName, columns, config);
  assertSoftDelete(tableName, columns, config);
  assertPagination(tableName, config);
}

/*
 * The `config` parameter type has three parts:
 * - `EntityConfig<T>` adds no constraint; it makes hovers on config fields show their docs.
 * - `C` is the config exactly as written (`const`), so the entity's types know its literal keys.
 * - `ConfigChecks<T, C>` adds the cross-field rules a plain interface can't express.
 */
/** Declares a CRUD entity for a table, validates its config at load time and derives its Zod schemas. */
export function defineEntity<T extends PgTable, const C extends EntityConfig<T>>(table: T, config: EntityConfig<T> & C & ConfigChecks<T, C>): Entity<T, C> {
  const name = getTableName(table);
  // `EntityConfig<T>` only narrows key types, so it is safe to use as `EntityConfig<PgTable>`.
  const runtimeConfig: EntityConfig<PgTable> = config;
  validateConfig(name, table, runtimeConfig);

  const serverOnly = serverOnlyKeys(runtimeConfig);
  const visibleKeys = Object.keys(getColumns(table)).filter((key) => !serverOnly.includes(key));
  const [first, ...rest] = visibleKeys;
  if (first === undefined) throw new Error(`${name}: every column is hidden`);

  return { name, table, config, schemas: buildSchemas(table, runtimeConfig, [first, ...rest], serverOnly) };
}
