import { and, eq, getColumns, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { BadRequestError, ConflictError, findPostgresError, mapDatabaseError, NotFoundError } from '../errors.ts';
import type {
  AnyEntity, Database, ListOptions, Logger, PaginationConfig, PrimaryKeyValue, QueryOptions, RepositoryFinders, Row, VisibleKey,
} from '../types.ts';
import { withExtend } from '../extend.ts';
import { buildFinders, typedFinders, type FinderMethods } from './finders.ts';
import { pickFields, selection, typedColumns, typedRows, visibleColumns, type ColumnMap } from './projection.ts';
import { createKeyset } from './cursor.ts';
import { orderBy, sortKeys, type SortKey } from './sort.ts';
import type { CrudRepository, CrudRepositoryBase, CrudRepositoryMethods, RepositoryInternals, RunnableQuery, ScopedQuery } from './types.ts';
import { whereToSql } from './utils.ts';

async function withErrorMapping<R>(query: () => Promise<R>): Promise<R> {
  try {
    return await query();
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Runs one statement and, if a logger is given, logs its SQL text and duration at `debug`.
 * Parameter values are never logged. Failed statements are logged too.
 */
async function logStatement<R>(log: Logger | undefined, entity: string, statement: PromiseLike<R>, sqlText: () => string): Promise<R> {
  const started = performance.now();
  try {
    return await statement;
  } finally {
    log?.debug({ entity, sql: sqlText(), durationMs: Math.round(performance.now() - started) }, 'sql');
  }
}

function requireColumn(columns: ColumnMap, key: string): PgColumn {
  const column = columns[key];
  if (!column) throw new Error(`Unknown column "${key}"`);
  return column;
}

// A foreign key error on a hard delete means the row is still referenced, so it is a conflict, not bad input.
function stillReferenced(error: unknown): unknown {
  const pgError = findPostgresError(error);
  if (pgError?.code !== '23503') return error;
  return new ConflictError('Resource is still referenced', { constraint: pgError.constraint, cause: error });
}

function firstOrNotFound<R>(rows: R[], name: string): R {
  const [row] = rows;
  if (row === undefined) throw new NotFoundError(`${name} not found`);
  return row;
}

/**
 * Returns the page size for a list call. Lists are never unlimited: missing settings fall back to the
 * library defaults, and `maxLimit` caps both the requested and the default limit.
 */
function resolveLimit(requested: number | undefined, { defaultLimit = 25, maxLimit = 100 }: PaginationConfig = {}): number {
  // A non-finite limit counts as not given, so it can't slip past `maxLimit`.
  const given = requested !== undefined && Number.isFinite(requested);
  const limit = given ? requested : defaultLimit;
  const atLeastOne = Math.max(limit, 1);
  return Math.min(atLeastOne, maxLimit);
}

/** The page size and offset for a list call. A cursor can't be combined with a non-zero offset. */
function pageWindow(options: Pick<ListOptions<AnyEntity>, 'limit' | 'offset' | 'cursor'>, pagination: PaginationConfig | undefined): { limit: number; offset: number } {
  const limit = resolveLimit(options.limit, pagination);
  let offset = 0;
  if (options.offset !== undefined && Number.isFinite(options.offset)) offset = Math.max(options.offset, 0);
  if (options.cursor !== undefined && offset > 0) throw new BadRequestError('Use either cursor or offset, not both');
  return { limit, offset };
}

/** What one list page selects: its columns, sort keys, full WHERE and window. */
interface PageQuery { columns: ColumnMap; keys: readonly SortKey[]; where: SQL | undefined; limit: number; offset: number }

/** Creates a typed CRUD repository for an entity. Works with any async Postgres drizzle database. */
export function createRepository<E extends AnyEntity>(db: Database, entity: E): CrudRepository<E> {
  const table: PgTable = entity.table;
  const { config, name } = entity;
  const columns: ColumnMap = getColumns(table);
  const visible = visibleColumns(table, config.hidden ?? []);
  const primaryColumn = requireColumn(columns, config.primaryKey);
  const softDeleteColumn = config.softDelete ? requireColumn(columns, config.softDelete) : undefined;
  const softDeleteValues = config.softDelete ? { [config.softDelete]: sql`now()` } : undefined;
  const defaultSort = config.defaultSort ? [config.defaultSort] : [];

  const executorFor = (options: QueryOptions): Database => options.tx ?? db;
  const baseWhere = (scope?: SQL): SQL | undefined =>
    and(softDeleteColumn ? isNull(softDeleteColumn) : undefined, scope);
  const byId = (id: PrimaryKeyValue<E>, scope?: SQL) => and(eq(primaryColumn, id), baseWhere(scope));
  const runStatement = <R>(log: Logger | undefined, query: RunnableQuery<R>) => logStatement(log, name, query, () => query.toSQL().sql);
  const sortBy = (sort?: readonly string[]) => orderBy(sortKeys(visible, sort ?? defaultSort, config.primaryKey));
  const keyset = createKeyset(table);

  // Scope, soft delete and the caller's filters, but not the cursor, so the total covers every page.
  const listWhere = (options: ListOptions<E> & QueryOptions) =>
    and(baseWhere(options.scope), whereToSql(visible, config.filterable ?? {}, options.where));

  const cursorWhere = (cursor: string | undefined, sort: readonly string[], keys: readonly SortKey[]) => {
    if (cursor === undefined) return undefined;
    return keyset.after(keys, keyset.decode(cursor, sort, keys));
  };

  // Fetches one row more than the limit, to tell whether another page follows.
  const fetchPage = (options: QueryOptions, page: PageQuery) => {
    const select = executorFor(options).select({ ...page.columns, ...keyset.fields(page.keys) }).from(table).where(page.where);
    return runStatement(options.log, select.orderBy(...orderBy(page.keys)).limit(page.limit + 1).offset(page.offset));
  };

  const countIfAsked = async (options: ListOptions<E> & QueryOptions, where: SQL | undefined) => {
    if (!options.withTotal) return undefined;
    // `$count` can't print its SQL, so it is logged as `count`.
    return logStatement(options.log, name, executorFor(options).$count(table, where), () => 'count');
  };

  const findMany: CrudRepositoryMethods<E>['findMany'] = (options = {}) =>
    withErrorMapping(async () => {
      const where = listWhere(options);
      const { limit, offset } = pageWindow(options, config.pagination);
      const sort = options.sort ?? defaultSort;
      const keys = sortKeys(visible, sort, config.primaryKey);
      const afterCursor = cursorWhere(options.cursor, sort, keys);
      const returned = selection(visible, options.columns);

      const [rows, total] = await Promise.all([
        fetchPage(options, { columns: returned, keys, where: and(where, afterCursor), limit, offset }),
        countIfAsked(options, where),
      ]);

      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);
      let nextCursor: string | null = null;
      if (rows.length > limit && lastRow !== undefined) nextCursor = keyset.encode(sort, keys, lastRow);
      // The cursor fields are internal, so callers get only the columns they asked for.
      const items = pageRows.map((row) => pickFields(row, Object.keys(returned)));
      return { items: typedRows(items), limit, offset, nextCursor, ...(total === undefined ? {} : { total }) };
    });

  const finders: FinderMethods = {};
  for (const finder of buildFinders(entity)) {
    // `async` so an invalid value or extra `where` rejects the promise instead of throwing synchronously.
    if (finder.valueCount === 1) {
      finders[finder.name] = async (value: unknown, options: ListOptions<E> & QueryOptions = {}) =>
        findMany({ ...options, where: finder.toWhere([value], options.where) });
    } else {
      finders[finder.name] = async (from: unknown, to: unknown, options: ListOptions<E> & QueryOptions = {}) =>
        findMany({ ...options, where: finder.toWhere([from, to], options.where) });
    }
  }

  const repository: CrudRepositoryBase<E> = {
    entity,
    db,
    findMany,
    ...typedFinders<RepositoryFinders<E>>(finders),

    findById: <K extends VisibleKey<E>>(id: PrimaryKeyValue<E>, options: { columns?: readonly K[] } & QueryOptions = {}) =>
      withErrorMapping(async () => {
        const query = executorFor(options).select(selection(visible, options.columns)).from(table).where(byId(id, options.scope)).limit(1);
        const rows = await runStatement(options.log, query);
        return typedRows<Pick<Row<E>, K>>(rows)[0] ?? null;
      }),

    create: (input, options = {}) =>
      withErrorMapping(async () => {
        const values: Record<string, unknown> = input;
        const rows = await runStatement(options.log, executorFor(options).insert(table).values(values).returning(visible));
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),

    update: (id, patch, options = {}) =>
      withErrorMapping(async () => {
        const values: Record<string, unknown> = patch;
        if (!Object.values(values).some((value) => value !== undefined)) throw new BadRequestError('Nothing to update');
        const query = executorFor(options).update(table).set(values).where(byId(id, options.scope)).returning(visible);
        const rows = await runStatement(options.log, query);
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),

    delete: (id, options = {}) =>
      withErrorMapping(async () => {
        const executor = executorFor(options);
        const where = byId(id, options.scope);
        const rows = softDeleteValues
          ? await runStatement(options.log, executor.update(table).set(softDeleteValues).where(where).returning(visible))
          : await runStatement(options.log, executor.delete(table).where(where).returning(visible)).catch((error: unknown) => {
              throw stillReferenced(error);
            });
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),
  };

  const scoped = (options: QueryOptions = {}): ScopedQuery => ({
    db: executorFor(options),
    where: (condition) => and(baseWhere(options.scope), condition),
    run: (query) => withErrorMapping(() => runStatement(options.log, query)),
  });

  const internals: RepositoryInternals<E> = {
    scoped,
    table: entity.table,
    project: (keys) => typedColumns(selection(visible, keys)),
    orderBy: sortBy,
  };

  // `X` collects the types of all methods added so far; see `withExtend`.
  const build = <X extends object>(methods: CrudRepositoryBase<E> & X): CrudRepository<E, X> => {
    const current: CrudRepository<E, X> = {
      ...methods,
      extend: <Y extends object>(factory: (internals: RepositoryInternals<E>) => Y) => build<X & Y>(withExtend(methods, factory(internals))),
    };
    return current;
  };
  return build(repository);
}
