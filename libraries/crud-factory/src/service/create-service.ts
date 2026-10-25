import type { SQL } from 'drizzle-orm';
import { findPostgresError } from '../errors.ts';
import { withExtend } from '../extend.ts';
import { buildFinders, typedFinders, type FinderMethods } from '../repository/finders.ts';
import type { CrudRepository } from '../repository/types.ts';
import type {
  AnyEntity,
  BetweenFinderName,
  CreateInput,
  Database,
  FilterKey,
  FilterValue,
  FinderName,
  Insert,
  FindByIdOptions,
  ListOptions,
  ListResult,
  NoOverride,
  Patch,
  PrimaryKeyValue,
  QueryOptions,
  RangeKey,
  RangeValue,
  Row,
  UpdateInput,
  VisibleKey,
} from '../types.ts';

/**
 * Per-call information passed to every service method. Generated routes build it; elsewhere, build it yourself.
 */
export interface ServiceContext<TAuth = unknown> {
  /** The caller's context from the routes' `context` option. Hooks can read it. */
  auth?: TAuth;
  /** An extra SQL condition that limits which rows this call can read or change. Routes set it from the `authorize` rules. */
  scope?: SQL;
  /** A transaction to run this call in, so several calls succeed or fail together. */
  transaction?: Database;
}

/**
 * What every write hook receives. `run` does the write itself; code before it runs before the write, code
 * after it runs after, and plain local variables carry values from one side to the other.
 */
interface WriteHookArgs<TAuth, TRun, R> {
  context: ServiceContext<TAuth>;
  /**
   * The service's repository, with its custom methods. Its calls skip the service's hooks, and join the
   * caller's transaction and scope only when you pass `context.transaction` and `context.scope`.
   */
  repository: R;
  /**
   * Writes to the database and returns the saved row. Call it exactly once: calling it twice, or returning
   * without calling it, throws. To reject the write, throw instead.
   *
   * **Don't catch its database errors inside a transaction** (every route has one by default). A failed
   * statement aborts the whole transaction: Postgres refuses every later query in it and rolls back every
   * write at the end, so the caller would get a success response for data that was never saved. If the hook
   * catches such an error and still returns, the service throws instead. Outside a transaction, catching
   * is safe.
   */
  run: TRun;
}

/** What the `create` hook receives. `run()` inserts `input` as-is; `run(insert)` inserts that row instead. */
export interface CreateHookArgs<E extends AnyEntity, TAuth, R extends CrudRepository<E> = CrudRepository<E>>
  extends WriteHookArgs<TAuth, (insert?: Insert<E>) => Promise<Row<E>>, R> {
  /** The client's input. Hidden columns aren't in it, so pass the full row to `run` to set them. */
  input: CreateInput<E>;
}

/** What the `update` hook receives. `run()` saves `patch` as-is; `run(changes)` saves those changes instead. */
export interface UpdateHookArgs<E extends AnyEntity, TAuth, R extends CrudRepository<E> = CrudRepository<E>>
  extends WriteHookArgs<TAuth, (changes?: Patch<E>) => Promise<Row<E>>, R> {
  id: PrimaryKeyValue<E>;
  /** The client's changes. */
  patch: UpdateInput<E>;
}

/**
 * What the `delete` hook receives. `run()` deletes the row, soft or hard, and returns it. To check the row
 * first, read it with `repository`, passing `context.transaction` and `context.scope`.
 */
export interface DeleteHookArgs<E extends AnyEntity, TAuth, R extends CrudRepository<E> = CrudRepository<E>>
  extends WriteHookArgs<TAuth, () => Promise<Row<E>>, R> {
  id: PrimaryKeyValue<E>;
}

/**
 * One function per write, wrapped around it. Each runs on every create, update or delete made through the
 * service, including custom methods that call `base`; calls made directly on `service.repository` skip them.
 * Without a hook, the service just runs the write.
 * A hook calls `run` to write, and returns the row the caller gets, usually `run`'s.
 * When `context.transaction` is set, as in routes by default, a hook that throws rolls back the write. Work
 * done outside the database, such as sending emails or events, can't be rolled back.
 * @example
 * create: async ({ input, context, run }) => {
 *   const row = await run({ ...input, orgId: context.auth.orgId });
 *   await notify(row);
 *   return row;
 * }
 */
export interface ServiceHooks<E extends AnyEntity, TAuth, R extends CrudRepository<E> = CrudRepository<E>> {
  create?(args: CreateHookArgs<E, TAuth, R>): Promise<Row<E>>;
  update?(args: UpdateHookArgs<E, TAuth, R>): Promise<Row<E>>;
  delete?(args: DeleteHookArgs<E, TAuth, R>): Promise<Row<E>>;
}

/** Options for `createService`. */
export interface ServiceOptions<E extends AnyEntity, TAuth, R extends CrudRepository<E> = CrudRepository<E>> {
  /** Functions wrapped around each create, update and delete. */
  hooks?: ServiceHooks<E, TAuth, R>;
}

type WriteOperation = 'create' | 'update' | 'delete';

/**
 * Wraps a write in the `run` a hook receives. `run` throws if it is called a second time, and `check`,
 * called after the hook returns, throws if the hook never called `run`, or if it swallowed a database
 * error inside a transaction.
 */
function guardWrite<TArgs extends unknown[], TRow>(
  operation: WriteOperation,
  inTransaction: boolean,
  write: (...args: TArgs) => Promise<TRow>,
) {
  let called = false;
  let databaseError: { error: unknown } | undefined;

  const run = async (...args: TArgs): Promise<TRow> => {
    if (called) throw new Error(`The service's ${operation} hook called run() more than once. Call it exactly once.`);
    called = true;
    try {
      return await write(...args);
    } catch (error) {
      // Only an error Postgres raised aborts the transaction; a `NotFoundError` for a missing row doesn't.
      if (findPostgresError(error)) databaseError = { error };
      throw error;
    }
  };

  const check = (): void => {
    if (!called) {
      throw new Error(
        `The service's ${operation} hook returned without calling run(), so nothing was written. ` +
          `Call run() to write, or throw to reject the ${operation}.`,
      );
    }
    if (databaseError && inTransaction) {
      throw new Error(
        `The service's ${operation} hook caught a database error from run(). ` +
          `The error aborted the transaction, so all of its writes will roll back and the call cannot succeed. Rethrow the error.`,
        { cause: databaseError.error },
      );
    }
  };

  return { run, check };
}

// How the finder types work is explained in docs/finder-types.md.

// `[Value] extends [unknown] ? … : never` is always true. It only makes editor hovers show the function's
// parameters instead of this type's name; see docs/finder-types.md.
/** A service finder for one column and operator: the rows whose column matches `value`. */
type ServiceFinder<E extends AnyEntity, TAuth, Value> = [Value] extends [unknown]
  ? <K extends VisibleKey<E> = VisibleKey<E>>(
      value: Value,
      context: ServiceContext<TAuth>,
      options?: ListOptions<E, K>,
    ) => Promise<ListResult<E, K>>
  : never;

/** A service range finder: the rows whose column is between `from` and `to`, inclusive. */
type ServiceRangeFinder<E extends AnyEntity, TAuth, Value> = [Value] extends [unknown]
  ? <K extends VisibleKey<E> = VisibleKey<E>>(
      from: Value,
      to: Value,
      context: ServiceContext<TAuth>,
      options?: ListOptions<E, K>,
    ) => Promise<ListResult<E, K>>
  : never;

/** One finder per operator declared in `filterable`. */
type ServiceValueFinders<E extends AnyEntity, TAuth> = {
  [P in FilterKey<E> as FinderName<E, P>]: ServiceFinder<E, TAuth, FilterValue<E, P>>;
};

/** One range finder per column that declares both `gte` and `lte`. */
type ServiceRangeFinders<E extends AnyEntity, TAuth> = {
  [C in RangeKey<E> as BetweenFinderName<C>]: ServiceRangeFinder<E, TAuth, RangeValue<E, C>>;
};

/**
 * Finder methods generated from the entity's `filterable` columns. They match the repository finders but
 * take a `context` after the value(s), and run through the service's `findMany`, so scope, soft delete
 * and the transaction all apply. `options` accepts everything `findMany` does; its `where` is ANDed with the finder's condition.
 */
export type ServiceFinders<E extends AnyEntity, TAuth = unknown> = ServiceValueFinders<E, TAuth> & ServiceRangeFinders<E, TAuth>;

/**
 * The built-in service: the CRUD methods, the generated finders, the entity and the repository.
 * `R` is the repository's type, so its custom methods stay typed on `repository`.
 */
export type CrudServiceBase<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>> =
  CrudServiceMethods<E, TAuth, R> & ServiceFinders<E, TAuth>;

/** The entity, the repository and the CRUD methods that every service has. */
export interface CrudServiceMethods<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>> {
  readonly entity: E;
  /** The wrapped repository, including its custom methods. Calls made on it skip the service's hooks. */
  readonly repository: R;
  findMany<K extends VisibleKey<E> = VisibleKey<E>>(options: ListOptions<E, K>, context: ServiceContext<TAuth>): Promise<ListResult<E, K>>;
  findById<K extends VisibleKey<E> = VisibleKey<E>>(
    id: PrimaryKeyValue<E>,
    options: FindByIdOptions<K>,
    context: ServiceContext<TAuth>,
  ): Promise<Pick<Row<E>, K> | null>;
  create(input: CreateInput<E>, context: ServiceContext<TAuth>): Promise<Row<E>>;
  update(id: PrimaryKeyValue<E>, patch: UpdateInput<E>, context: ServiceContext<TAuth>): Promise<Row<E>>;
  delete(id: PrimaryKeyValue<E>, context: ServiceContext<TAuth>): Promise<Row<E>>;
}

/** The result of `createService`: the built-in methods plus `X`, the methods added with `extend` so far. */
export type CrudService<
  E extends AnyEntity,
  TAuth = unknown,
  R extends CrudRepository<E> = CrudRepository<E>,
  X extends object = {},
> = CrudServiceBase<E, TAuth, R> &
  X & {
    /**
     * Returns a new service with your own methods added; the original is unchanged. `base` is the service
     * so far, and reusing a built-in name is a compile error. Pass a `context` through to the `base` methods
     * so that hooks, scope and the transaction apply.
     */
    extend<Y extends object>(
      factory: (base: CrudService<E, TAuth, R, X>) => Y & NoOverride<keyof CrudServiceBase<E, TAuth, R> | 'extend'>,
    ): CrudService<E, TAuth, R, X & Y>;
  };

/**
 * Wraps a repository with hooks.
 * If you pass type arguments yourself, pass the repository's type third to keep its custom methods typed.
 */
export function createService<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>>(
  // The intersection lets TypeScript infer `E` from `CrudRepository<E>` and the full repository type from `R`.
  repository: R & CrudRepository<E>,
  options: ServiceOptions<E, TAuth, R> = {},
): CrudService<E, TAuth, R> {
  const { hooks = {} } = options;

  const queryOptions = (context: ServiceContext<TAuth>): QueryOptions => ({ transaction: context.transaction, scope: context.scope });

  const findMany: CrudServiceMethods<E, TAuth, R>['findMany'] = (listOptions, context) =>
    repository.findMany({ ...listOptions, ...queryOptions(context) });

  const finders: FinderMethods = {};
  for (const finder of buildFinders(repository.entity)) {
    // `async` so an invalid value or extra `where` rejects the promise instead of throwing synchronously.
    if (finder.valueCount === 1) {
      finders[finder.name] = async (value: unknown, context: ServiceContext<TAuth>, listOptions: ListOptions<E> = {}) =>
        findMany({ ...listOptions, where: finder.toWhere([value], listOptions.where) }, context);
    } else {
      finders[finder.name] = async (from: unknown, to: unknown, context: ServiceContext<TAuth>, listOptions: ListOptions<E> = {}) =>
        findMany({ ...listOptions, where: finder.toWhere([from, to], listOptions.where) }, context);
    }
  }

  const service: CrudServiceBase<E, TAuth, R> = {
    entity: repository.entity,
    repository,
    findMany,
    ...typedFinders<ServiceFinders<E, TAuth>>(finders),
    findById: (id, findOptions, context) => repository.findById(id, { ...findOptions, ...queryOptions(context) }),
    create: async (input, context) => {
      // `run()` inserts the input as-is, so omitted columns must have database defaults.
      // The cast is needed because TypeScript can't relate the two `Omit` types over a generic table.
      const write = (insert: Insert<E> = input as Insert<E>) => repository.create(insert, queryOptions(context));
      if (!hooks.create) return write();
      const { run, check } = guardWrite('create', context.transaction !== undefined, write);
      const row = await hooks.create({ input, context, repository, run });
      check();
      return row;
    },
    update: async (id, patch, context) => {
      // `UpdateInput` is a subset of `Patch`, so this cast is safe.
      const write = (changes: Patch<E> = patch as Patch<E>) => repository.update(id, changes, queryOptions(context));
      if (!hooks.update) return write();
      const { run, check } = guardWrite('update', context.transaction !== undefined, write);
      const row = await hooks.update({ id, patch, context, repository, run });
      check();
      return row;
    },
    delete: async (id, context) => {
      const write = () => repository.delete(id, queryOptions(context));
      if (!hooks.delete) return write();
      const { run, check } = guardWrite('delete', context.transaction !== undefined, write);
      const row = await hooks.delete({ id, context, repository, run });
      check();
      return row;
    },
  };

  // `X` collects the types of all methods added so far; see `withExtend`.
  const build = <X extends object>(methods: CrudServiceBase<E, TAuth, R> & X): CrudService<E, TAuth, R, X> => {
    const current: CrudService<E, TAuth, R, X> = {
      ...methods,
      extend: <Y extends object>(factory: (base: CrudService<E, TAuth, R, X>) => Y) => build<X & Y>(withExtend(methods, factory(current))),
    };
    return current;
  };
  return build(service);
}
