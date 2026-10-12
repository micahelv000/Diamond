import type { SQL } from 'drizzle-orm';
import type {
  AnyEntity,
  Database,
  Insert,
  FindByIdOptions,
  ListOptions,
  ListResult,
  Logger,
  NoOverride,
  Patch,
  PrimaryKeyValue,
  QueryOptions,
  RepositoryFinders,
  Row,
  SortSpec,
  VisibleKey,
} from '../types.ts';

/** The tools `.extend()` provides for writing custom queries. */
export interface RepositoryInternals<E extends AnyEntity> {
  /**
   * The database the repository was created with. Run custom queries on the caller's `tx` when one is
   * given, so they join its transaction; a query on `db` alone runs outside it and survives a rollback.
   */
  db: Database;
  /** The entity's drizzle table, for building queries and referencing its columns. */
  table: E['table'];
  /**
   * The conditions every built-in query applies: rows that are not soft-deleted and match the caller's `scope`.
   * Add it to a custom query's `where`, or it will also return deleted rows and rows outside the scope.
   */
  baseWhere(scope?: SQL): SQL | undefined;
  /**
   * The table's visible columns, ready to spread into a `select`.
   * Pass column names to pick only some of them.
   */
  project<K extends VisibleKey<E> = VisibleKey<E>>(keys?: readonly K[]): Pick<E['table']['_']['columns'], K>;
  /**
   * Runs a query and returns its result, mapping database errors like the built-in methods do.
   * When `log` is given, it logs the SQL text (never the values) and duration at `debug`.
   */
  run<R>(query: RunnableQuery<R>, log?: Logger): Promise<R>;
  /**
   * The ORDER BY clauses for `sort`, or for the entity's `defaultSort` when omitted, always ending with
   * the primary key. Only visible columns can be sorted on; any other key throws `BadRequestError`.
   */
  orderBy(sort?: readonly SortSpec<E>[]): SQL[];
}

/** A drizzle query builder that can be awaited and can print its SQL. */
export type RunnableQuery<R> = PromiseLike<R> & { toSQL(): { sql: string } };

/** The built-in repository: the entity, its database, the CRUD methods and the generated finders, without `.extend()`. */
export type CrudRepositoryBase<E extends AnyEntity> = CrudRepositoryMethods<E> & RepositoryFinders<E>;

/** The entity, its database and the CRUD methods every repository has. */
export interface CrudRepositoryMethods<E extends AnyEntity> {
  /** The entity this repository was created for. */
  readonly entity: E;
  /** The database this repository was created with. Use it to open your own transactions and pass `tx` to each call. */
  readonly db: Database;
  /**
   * Lists rows. `where` takes a typed filter object or a raw `SQL` chunk. Results are sorted by `sort`
   * or `defaultSort`, always ending with the primary key.
   */
  findMany<K extends VisibleKey<E> = VisibleKey<E>>(options?: ListOptions<E, K> & QueryOptions): Promise<ListResult<E, K>>;
  /** Returns the row with this id, or `null` if none matches. */
  findById<K extends VisibleKey<E> = VisibleKey<E>>(
    id: PrimaryKeyValue<E>,
    options?: FindByIdOptions<K> & QueryOptions,
  ): Promise<Pick<Row<E>, K> | null>;
  /** Inserts a row and returns it. */
  create(input: Insert<E>, options?: QueryOptions): Promise<Row<E>>;
  /** Updates a row and returns it. Throws `NotFoundError` when no row matches the id and scope. */
  update(id: PrimaryKeyValue<E>, patch: Patch<E>, options?: QueryOptions): Promise<Row<E>>;
  /** Deletes a row, or soft-deletes it when configured, and returns it. Throws `NotFoundError` when no row matches. */
  delete(id: PrimaryKeyValue<E>, options?: QueryOptions): Promise<Row<E>>;
}

/** A repository from `createRepository`: the built-in methods plus `X`, the methods added with `.extend()` so far. */
export type CrudRepository<E extends AnyEntity, X extends object = {}> = CrudRepositoryBase<E> &
  X & {
    /**
     * Returns a new repository with the given custom methods added, keeping all earlier ones.
     * Reusing a built-in method name is a compile error.
     */
    extend<Y extends object>(
      factory: (internals: RepositoryInternals<E>) => Y & NoOverride<keyof CrudRepositoryBase<E> | 'extend'>,
    ): CrudRepository<E, X & Y>;
  };
