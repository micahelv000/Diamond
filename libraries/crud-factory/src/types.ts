import type { AnyRelations, InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';

/** Any async Postgres drizzle database. A transaction also counts as one. */
export type Database = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/** The logger methods the library uses. Pino and Fastify's request logger both fit. */
export interface Logger {
  debug(details: object, message?: string): void;
  warn(details: object, message?: string): void;
}

// ── Entity config ──

/** The filter operators a column can allow in `filterable`. */
export type FilterOperator = 'eq' | 'in' | 'ilike' | 'gte' | 'lte';

// Uses `Extract` instead of `keyof … & string` so editor hovers list the actual keys.
/** A column's TypeScript property name, not its database name. */
export type ColumnKey<T extends PgTable> = Extract<keyof InferSelectModel<T>, string>;

/** The config passed to `defineEntity`. Only `primaryKey` is required. */
export interface EntityConfig<T extends PgTable> {
  /** The column that uniquely identifies a row. Routes use it as the `:id` parameter. */
  primaryKey: ColumnKey<T>;
  /**
   * Secret columns that are never selected, returned or accepted from clients.
   * They can't be filterable or sortable. Set them on the server in a service hook.
   */
  hidden?: readonly ColumnKey<T>[];
  /** What a client may send when creating a row. */
  create?: WriteConfig<ColumnKey<T>>;
  /** What a client may send when updating a row. The primary key is always left out. */
  update?: WriteConfig<ColumnKey<T>>;
  /**
   * The filter operators each column allows. Each operator adds a typed finder method to the
   * repository and service, a `column__operator` key for `where` objects, and the same key as a list
   * route querystring filter. Other filter keys in the URL get a 400.
   * `ilike` needs a text column; `gte` plus `lte` also adds a range finder. Only list indexed
   * columns, or queries will scan the whole table.
   */
  filterable?: { [K in ColumnKey<T>]?: readonly FilterOperator[] };
  /**
   * Columns clients may sort the list route by with `?sort=`. Other columns get a 400.
   * This only limits the URL; code can sort by any visible column.
   */
  sortable?: readonly ColumnKey<T>[];
  /**
   * The sort used when none is given: any visible column, with a leading `-` for descending.
   * Defaults to the primary key, which is always the final tie-breaker.
   */
  defaultSort?: string;
  /**
   * Page-size limits for lists. Either setting can be left out to keep its default; lists are never unlimited.
   * @default { defaultLimit: 25, maxLimit: 100 }
   */
  pagination?: PaginationConfig;
  /**
   * A nullable timestamp column that turns delete into a soft delete: the row gets the current time
   * here instead of being removed, and reads skip it. Clients can't set it.
   */
  softDelete?: ColumnKey<T>;
}

/** Field rules for a create or update. */
export interface WriteConfig<K extends string> {
  /**
   * Columns a client may not send. Use it for columns the database fills in or the server
   * controls, and set the latter in a service hook.
   */
  omit?: readonly K[];
}

/** Page-size settings for lists. */
export interface PaginationConfig {
  /**
   * Rows returned when no limit is given. Lowered to `maxLimit` if larger.
   * @default 25
   */
  defaultLimit?: number;
  /**
   * The most rows one list can return. Larger limits are lowered to this.
   * @default 100
   */
  maxLimit?: number;
}

/** What `defineEntity` returns: the table, its config and its derived Zod schemas. */
export interface Entity<T extends PgTable, C extends EntityConfig<T>> extends AnyEntity {
  readonly table: T;
  readonly config: C;
  readonly schemas: EntitySchemas<Entity<T, C>>;
}

// ── Rows and inputs ──

/** Flattens a computed object type so hovers show its fields. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Marks keys as `never` so an `.extend()` factory can't override a built-in method by name. */
export type NoOverride<K extends PropertyKey> = { [P in K]?: never };

/** The minimal entity shape that the helper types accept. */
export interface AnyEntity {
  readonly name: string;
  readonly table: PgTable;
  readonly config: EntityConfig<PgTable>;
}

type TableOf<E extends AnyEntity> = E['table'];
type Config<E extends AnyEntity> = E['config'];
/** The string union in a config list, or `never` when the option is missing. */
export type ArrayItem<V> = V extends readonly (infer K extends string)[] ? K : never;

export type HiddenKey<E extends AnyEntity> = ArrayItem<Config<E>['hidden']>;
type PrimaryKey<E extends AnyEntity> = Config<E>['primaryKey'];
export type VisibleKey<E extends AnyEntity> = Exclude<ColumnKey<TableOf<E>>, HiddenKey<E>>;
/** A sort key for code queries: any visible column, with a leading `-` for descending. */
export type SortSpec<E extends AnyEntity> = VisibleKey<E> | `-${VisibleKey<E>}`;

/** A row as returned to callers: `$inferSelect` without hidden columns. */
export type Row<E extends AnyEntity> = Simplify<Omit<InferSelectModel<TableOf<E>>, HiddenKey<E>>>;
export type PrimaryKeyValue<E extends AnyEntity> = InferSelectModel<TableOf<E>>[PrimaryKey<E>];

/** The repository insert type: the full `$inferInsert`, so server code can set any column. */
export type Insert<E extends AnyEntity> = InferInsertModel<TableOf<E>>;
/** The repository update type: any insertable column except the primary key. */
export type Patch<E extends AnyEntity> = Partial<Omit<Insert<E>, PrimaryKey<E>>>;
// Clients can't send hidden or soft-delete columns; server hooks set them through `Insert` and `Patch`.
type ServerOnlyKey<E extends AnyEntity> = HiddenKey<E> | (Config<E> extends { softDelete: infer K extends string } ? K : never);
/** The create body clients send: `$inferInsert` without omitted, hidden and soft-delete columns. */
export type CreateInput<E extends AnyEntity> = Simplify<
  Omit<Insert<E>, ArrayItem<NonNullable<Config<E>['create']>['omit']> | ServerOnlyKey<E>>
>;
/** The update body clients send: a partial `$inferInsert` without omitted, hidden, soft-delete and primary key columns. */
export type UpdateInput<E extends AnyEntity> = Simplify<
  Omit<Patch<E>, ArrayItem<NonNullable<Config<E>['update']>['omit']> | ServerOnlyKey<E>>
>;

// ── Filters ──

type Filterable<E extends AnyEntity> = NonNullable<Config<E>['filterable']>;
// Uses `Exclude` instead of `NonNullable` so hovers show the resolved type.
type ColumnValue<E extends AnyEntity, K extends string> = Exclude<InferSelectModel<TableOf<E>>[K & ColumnKey<TableOf<E>>], null>;
/** Every allowed filter as a `column__operator` key. */
export type FilterKey<E extends AnyEntity> = {
  [K in keyof Filterable<E> & string]: `${K}__${ArrayItem<Filterable<E>[K]>}`;
}[keyof Filterable<E> & string];
/** The filter value type for each operator, given the column's value type `V`. */
interface OperatorValue<V> {
  eq: V;
  in: V[];
  ilike: string;
  gte: V;
  lte: V;
}
/** The value type for one `column__operator` key. */
export type FilterValue<E extends AnyEntity, P extends string> = P extends `${infer K}__${infer O extends FilterOperator}`
  ? OperatorValue<ColumnValue<E, K>>[O]
  : never;

/** A typed filter object with `column__operator` keys, limited to `filterable`. */
export type Filter<E extends AnyEntity> = Simplify<{ [P in FilterKey<E>]?: FilterValue<E, P> }>;

// ── Finders ──

/** The finder method-name suffix for each filter operator. */
export interface FinderSuffix {
  eq: '';
  in: 'In';
  ilike: 'Containing';
  gte: 'From';
  lte: 'Until';
}
// The primary key has no `eq` finder because `findById` covers it.
type PrimaryKeyEqKey<E extends AnyEntity> = `${PrimaryKey<E>}__eq`;
/** `findBy<Column><Suffix>` for a `column__operator` key. */
type FinderMethodName<P extends string> = P extends `${infer K}__${infer O extends FilterOperator}`
  ? `findBy${Capitalize<K>}${FinderSuffix[O]}`
  : never;
/** The finder method name for a `column__operator` key: none for the primary key's `eq`, else `findBy<Column><Suffix>`. */
export type FinderName<E extends AnyEntity, P extends string> = P extends PrimaryKeyEqKey<E> ? never : FinderMethodName<P>;
/** Columns that allow both `gte` and `lte`, which also get a range finder. */
export type RangeKey<E extends AnyEntity> = {
  [K in keyof Filterable<E> & string]: 'gte' | 'lte' extends ArrayItem<Filterable<E>[K]> ? K : never;
}[keyof Filterable<E> & string];
/** The type of both ends of a range finder. */
export type RangeValue<E extends AnyEntity, K extends string> = ColumnValue<E, K>;
/** The range finder method name for a column. */
export type BetweenFinderName<C extends string> = `findBy${Capitalize<C>}Between`;

// How the finder types work is explained in docs/finder-types.md.

// `[Value] extends [unknown] ? … : never` is always true. It only makes editor hovers show the function's
// parameters instead of this type's name; see docs/finder-types.md.
/** A repository finder for one column and operator: the rows whose column matches `value`. */
type RepositoryFinder<E extends AnyEntity, Value> = [Value] extends [unknown]
  ? <K extends VisibleKey<E> = VisibleKey<E>>(
      value: Value,
      options?: ListOptions<E, K> & QueryOptions,
    ) => Promise<ListResult<E, K>>
  : never;

/** A repository range finder: the rows whose column is between `from` and `to`, inclusive. */
type RepositoryRangeFinder<E extends AnyEntity, Value> = [Value] extends [unknown]
  ? <K extends VisibleKey<E> = VisibleKey<E>>(
      from: Value,
      to: Value,
      options?: ListOptions<E, K> & QueryOptions,
    ) => Promise<ListResult<E, K>>
  : never;

/** One finder per operator declared in `filterable`. */
type RepositoryValueFinders<E extends AnyEntity> = {
  [P in FilterKey<E> as FinderName<E, P>]: RepositoryFinder<E, FilterValue<E, P>>;
};

/** One range finder per column that declares both `gte` and `lte`. */
type RepositoryRangeFinders<E extends AnyEntity> = {
  [C in RangeKey<E> as BetweenFinderName<C>]: RepositoryRangeFinder<E, RangeValue<E, C>>;
};

/**
 * The finder methods generated from `filterable`: one per allowed operator, plus an inclusive range
 * finder for columns with both `gte` and `lte`. Each returns a page like `findMany` and accepts the
 * same options; an extra `where` is combined with the finder's own condition using AND.
 */
export type RepositoryFinders<E extends AnyEntity> = RepositoryValueFinders<E> & RepositoryRangeFinders<E>;

// ── Listing ──

/** Per-call database options that every repository method accepts. */
export interface QueryOptions {
  /** A transaction to run this call in, so several calls succeed or fail together. */
  tx?: Database;
  /**
   * An extra SQL condition that limits which rows this call can read or change. Rows outside it act
   * as if they don't exist. Routes set it from your `authorize` rules.
   */
  scope?: SQL;
  /**
   * A logger for each SQL statement this call runs, at `debug` level, with its text and duration but
   * never its values. Nothing is logged when it is not set.
   */
  log?: Logger;
}

/** Options for a list call. All fields are optional. */
export interface ListOptions<E extends AnyEntity, K extends VisibleKey<E> = VisibleKey<E>> {
  /** Which rows to return: a filter object using the `filterable` operators, or a drizzle SQL condition. */
  where?: Filter<E> | SQL;
  /** Fetch only these columns instead of all visible ones. The return type narrows to match. */
  columns?: readonly K[];
  /**
   * The row order, with a leading `-` for descending. Falls back to `defaultSort`. The primary key is
   * always added last so pages stay stable.
   */
  sort?: readonly SortSpec<E>[];
  /**
   * How many rows to return. Falls back to `pagination.defaultLimit` and is capped at `pagination.maxLimit`.
   * @default 25
   */
  limit?: number;
  /** How many rows to skip. Defaults to 0. Can't be combined with `cursor`. */
  offset?: number;
  /**
   * A `nextCursor` from an earlier page: this page starts right after that page's last row. Pass the
   * same `sort`, filters and scope as the earlier call. A malformed cursor, one made for another `sort`,
   * or one combined with a non-zero `offset` throws `BadRequestError`.
   */
  cursor?: string;
  /**
   * Also return the count of all matching rows as `total`. This runs an extra count query. The count
   * ignores `cursor` and `offset`, so it covers every page.
   */
  withTotal?: boolean;
}

/** What to fetch when reading one row by id. */
export interface FindByIdOptions<K extends string> {
  /** Fetch only these columns instead of all visible ones. The return type narrows to match. */
  columns?: readonly K[];
}

/** One page of a list call. */
export interface ListResult<E extends AnyEntity, K extends VisibleKey<E> = VisibleKey<E>> {
  /** The rows on this page. */
  items: Simplify<Pick<Row<E>, K>>[];
  /** The page size actually used, after defaults and the cap. */
  limit: number;
  /** How many rows were skipped before this page. */
  offset: number;
  /** Pass as `cursor` to get the page after this one. `null` when this is the last page. */
  nextCursor: string | null;
  /** The number of matching rows across all pages. Only set when `withTotal` was requested. */
  total?: number;
}

/** Zod schemas derived from the table for validating requests and responses. */
export interface EntitySchemas<E extends AnyEntity> {
  read: z.ZodType<Row<E>, Row<E>>;
  /** `read` with every field optional, for responses limited to requested fields. */
  readPartial: z.ZodType<Partial<Row<E>>, Partial<Row<E>>>;
  create: z.ZodType<CreateInput<E>>;
  update: z.ZodType<UpdateInput<E>>;
  params: z.ZodType<{ id: PrimaryKeyValue<E> }>;
  /** Parses the list querystring into `ListOptions` and rejects unknown keys. */
  listQuery: z.ZodType<ListOptions<E>>;
  /** Parses the get-by-id querystring into `{ columns }`. */
  getQuery: z.ZodType<{ columns?: VisibleKey<E>[] }>;
  /** The list response. Items are partial because the client may request only some fields. */
  listResult: z.ZodType<ListResponse<E>, ListResponse<E>>;
}

/** The list response body: a `ListResult` whose items may hold only the requested fields. */
export type ListResponse<E extends AnyEntity> = Omit<ListResult<E>, 'items'> & { items: Partial<Row<E>>[] };
