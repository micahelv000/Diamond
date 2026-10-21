import type { SQL } from 'drizzle-orm';
import type {
  AnyEntity,
  Database,
  Insert,
  FindByIdOptions,
  ListOptions,
  ListResult,
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
   * The way to reach the database from a custom query. Pass the caller's options and a function that
   * builds the query from the `database` and `visible` it is given. They apply the caller's transaction and
   * scope, plus soft delete, the same way the built-in methods do. Building and running both happen inside
   * the error mapping, so the result is the query's rows, with database errors mapped like the built-in methods.
   */
  scoped<R>(options: QueryOptions, buildQuery: (tools: ScopedTools) => PromiseLike<R>): Promise<R>;
  /** The entity's drizzle table, for building queries and referencing its columns. */
  table: E['table'];
  /**
   * The table's visible columns, ready to spread into a `select`.
   * Pass column names to pick only some of them.
   */
  columns<K extends VisibleKey<E> = VisibleKey<E>>(keys?: readonly K[]): Pick<E['table']['_']['columns'], K>;
  /**
   * The ORDER BY clauses for `sort`, or for the entity's `defaultSort` when omitted, always ending with
   * the primary key. Only visible columns can be sorted on; any other key throws `BadRequestError`.
   */
  orderBy(sort?: readonly SortSpec<E>[]): SQL[];
}

/** What `scoped` gives the function that builds a custom query. */
export interface ScopedTools {
  /** The database to build the query on: the caller's `transaction` when given, so the query joins its transaction. */
  database: Database;
  /**
   * The condition for the rows the caller may see: not soft-deleted and matching its `scope`, ANDed
   * with `condition` when given.
   */
  visible(condition?: SQL): SQL | undefined;
}

/** The built-in repository: the entity, its database, the CRUD methods and the generated finders, without `.extend()`. */
export type CrudRepositoryBase<E extends AnyEntity> = CrudRepositoryMethods<E> & RepositoryFinders<E>;

/** The entity, its database and the CRUD methods every repository has. */
export interface CrudRepositoryMethods<E extends AnyEntity> {
  /** The entity this repository was created for. */
  readonly entity: E;
  /** The database this repository was created with. Use it to open your own transactions and pass `transaction` to each call. */
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
