import { and, eq, getColumns, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { BadRequestError, ConflictError, findPostgresError, mapDatabaseError, NotFoundError } from '../errors.ts';
import type {
  AnyEntity, Database, ListOptions, Logger, PaginationConfig, PrimaryKeyValue, QueryOptions, RepositoryFinders, Row, VisibleKey,
} from '../types.ts';
import { buildFinders } from './finders.ts';
import { selection, typedColumns, typedRows, visibleColumns, type ColumnMap } from './projection.ts';
import { orderBy } from './sort.ts';
import type { CrudRepository, CrudRepositoryBase, CrudRepositoryMethods, RepositoryInternals, RunnableQuery } from './types.ts';
import { whereToSql } from './where.ts';

async function mapErrors<R>(query: () => Promise<R>): Promise<R> {
  try {
    return await query();
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Wraps methods added with `extend` so their rejected promises go through `mapDatabaseError`, giving
 * constraint violations the same 409/400 errors as the base methods instead of a 500.
 * Non-promise results are returned untouched.
 */
function withMappedErrors<X extends object>(methods: X): X {
  const wrapped = { ...methods };
  for (const key of Object.keys(wrapped)) {
    const method: unknown = Reflect.get(wrapped, key);
    if (typeof method !== 'function') continue;
    // TypeScript can't type an index assignment on a generic `X`, so `Reflect.set` is used. The wrapper
    // keeps the same arguments, `this` and result, so the value still matches `X`.
    Reflect.set(wrapped, key, function (this: unknown, ...args: unknown[]): unknown {
      const result: unknown = Reflect.apply(method, this, args);
      return result instanceof Promise ? result.catch((error: unknown) => { throw mapDatabaseError(error); }) : result;
    });
  }
  return wrapped;
}

/**
 * Runs one statement and, if a logger is given, logs its SQL text and duration at `debug`.
 * Parameter values are never logged. Failed statements are logged too.
 */
async function execute<R>(log: Logger | undefined, entity: string, statement: PromiseLike<R>, sqlText: () => string): Promise<R> {
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
 * Returns the page size for a list call, or `undefined` for no limit.
 * `maxLimit` caps both the requested and the default limit.
 */
function resolveLimit(requested: number | undefined, pagination: PaginationConfig = {}): number | undefined {
  const { defaultLimit, maxLimit } = pagination;
  // A non-finite limit counts as not given, so it can't slip past `maxLimit`.
  const given = requested !== undefined && Number.isFinite(requested) ? requested : undefined;
  const limit = given ?? defaultLimit ?? maxLimit;
  if (limit === undefined) return undefined;
  const atLeastOne = Math.max(limit, 1);
  return maxLimit === undefined ? atLeastOne : Math.min(atLeastOne, maxLimit);
}

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

  const baseWhere = (scope?: SQL): SQL | undefined =>
    and(softDeleteColumn ? isNull(softDeleteColumn) : undefined, scope);
  const byId = (id: unknown, scope?: SQL) => and(eq(primaryColumn, id), baseWhere(scope));
  const run = <R>(log: Logger | undefined, query: RunnableQuery<R>) => execute(log, name, query, () => query.toSQL().sql);
  const sortBy = (sort?: readonly string[]) => orderBy(visible, sort ?? defaultSort, config.primaryKey);

  const findMany: CrudRepositoryMethods<E>['findMany'] = (options = {}) =>
    mapErrors(async () => {
      const executor = options.tx ?? db;
      const where = and(baseWhere(options.scope), whereToSql(visible, config.filterable ?? {}, options.where));
      const limit = resolveLimit(options.limit, config.pagination);
      const offset = options.offset !== undefined && Number.isFinite(options.offset) ? Math.max(options.offset, 0) : 0;
      const query = executor.select(selection(visible, options.columns)).from(table).where(where).orderBy(...sortBy(options.sort)).$dynamic();
      const page = (limit === undefined ? query : query.limit(limit)).offset(offset);
      const [rows, total] = await Promise.all([
        run(options.log, page),
        // `$count` can't print its SQL, so it is logged as `count`.
        options.withTotal ? execute(options.log, name, executor.$count(table, where), () => 'count') : undefined,
      ]);
      return { items: typedRows(rows), limit: limit ?? null, offset, ...(total === undefined ? {} : { total }) };
    });

  const repository: CrudRepositoryBase<E> = {
    entity,
    db,
    findMany,
    ...buildFinders<RepositoryFinders<E>, [options?: ListOptions<E> & QueryOptions]>(entity, (where, [options = {}]) =>
      findMany({ ...options, where: where(options.where) })),

    findById: <K extends VisibleKey<E>>(id: PrimaryKeyValue<E>, options: { columns?: readonly K[] } & QueryOptions = {}) =>
      mapErrors(async () => {
        const executor = options.tx ?? db;
        const rows = await run(options.log, executor.select(selection(visible, options.columns)).from(table).where(byId(id, options.scope)).limit(1));
        return typedRows<Pick<Row<E>, K>>(rows)[0] ?? null;
      }),

    create: (input, options = {}) =>
      mapErrors(async () => {
        const values: Record<string, unknown> = input;
        const rows = await run(options.log, (options.tx ?? db).insert(table).values(values).returning(visible));
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),

    update: (id, patch, options = {}) =>
      mapErrors(async () => {
        const values: Record<string, unknown> = patch;
        if (!Object.values(values).some((value) => value !== undefined)) throw new BadRequestError('Nothing to update');
        const rows = await run(options.log, (options.tx ?? db).update(table).set(values).where(byId(id, options.scope)).returning(visible));
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),

    delete: (id, options = {}) =>
      mapErrors(async () => {
        const executor = options.tx ?? db;
        const where = byId(id, options.scope);
        const rows = softDeleteValues
          ? await run(options.log, executor.update(table).set(softDeleteValues).where(where).returning(visible))
          : await run(options.log, executor.delete(table).where(where).returning(visible)).catch((error: unknown) => {
              throw stillReferenced(error);
            });
        return firstOrNotFound(typedRows<Row<E>>(rows), name);
      }),
  };

  const internals: RepositoryInternals<E> = {
    db,
    table: entity.table,
    baseWhere,
    project: (keys) => typedColumns(selection(visible, keys)),
    run: (query, log) => mapErrors(() => run(log, query)),
    orderBy: sortBy,
  };

  // `X` collects the types of all methods added so far, so each `extend` keeps the earlier ones.
  const build = <X extends object>(methods: CrudRepositoryBase<E> & X): CrudRepository<E, X> => ({
    ...methods,
    extend: <Y extends object>(factory: (internals: RepositoryInternals<E>) => Y) =>
      build<X & Y>({ ...methods, ...withMappedErrors(factory(internals)) }),
  });
  return build(repository);
}
