import type { SQL } from 'drizzle-orm';
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
  tx?: Database;
}

/**
 * Functions that run around every create, update and delete made through the service, including custom
 * methods that call `base`. Calls made directly on `service.repository` skip them. Each may be async.
 * When `context.tx` is set, as in routes by default, a hook that throws rolls back the write. Work done outside
 * the database, such as sending emails or events, can't be rolled back.
 */
export interface ServiceHooks<E extends AnyEntity, TAuth> {
  /**
   * Runs before every create. Receives the client's input and returns the full row to insert, so it can
   * set columns that clients may not send. Throw to reject the request.
   */
  beforeCreate?(args: { input: CreateInput<E>; context: ServiceContext<TAuth> }): Insert<E> | Promise<Insert<E>>;
  /** Runs after every create succeeds, with the saved row and the client's input. Its return value is ignored. */
  afterCreate?(args: { row: Row<E>; input: CreateInput<E>; context: ServiceContext<TAuth> }): void;
  /** Runs before every update. Receives the id and the client's changes, and returns the changes to save. Throw to reject the request. */
  beforeUpdate?(args: {
    id: PrimaryKeyValue<E>;
    patch: UpdateInput<E>;
    context: ServiceContext<TAuth>;
  }): Patch<E> | Promise<Patch<E>>;
  /** Runs after every update succeeds, with the saved row and the client's changes. Its return value is ignored. */
  afterUpdate?(args: { id: PrimaryKeyValue<E>; row: Row<E>; patch: UpdateInput<E>; context: ServiceContext<TAuth> }): void;
  /**
   * Runs before every delete. Throw to block it. It receives only the id; to check the row, read it
   * with the repository, passing `context.tx` and `context.scope`.
   */
  beforeDelete?(args: { id: PrimaryKeyValue<E>; context: ServiceContext<TAuth> }): void;
  /** Runs after every delete succeeds, soft or hard, with the deleted row. Its return value is ignored. */
  afterDelete?(args: { id: PrimaryKeyValue<E>; row: Row<E>; context: ServiceContext<TAuth> }): void;
}

/** Options for `createService`. */
export interface ServiceOptions<E extends AnyEntity, TAuth> {
  /** Functions that run before and after each create, update and delete. */
  hooks?: ServiceHooks<E, TAuth>;
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
  options: ServiceOptions<E, TAuth> = {},
): CrudService<E, TAuth, R> {
  const { hooks = {} } = options;

  const queryOptions = (context: ServiceContext<TAuth>): QueryOptions => ({ tx: context.tx, scope: context.scope });
  // Without a hook the input is inserted as-is, so omitted columns must have database defaults.
  // The casts are needed because TypeScript can't relate the two `Omit` types over a generic table.
  const toInsert = async (input: CreateInput<E>, context: ServiceContext<TAuth>): Promise<Insert<E>> =>
    hooks.beforeCreate ? hooks.beforeCreate({ input, context }) : (input as Insert<E>);
  // `UpdateInput` is a subset of `Patch`, so this cast is safe.
  const toPatch = async (id: PrimaryKeyValue<E>, patch: UpdateInput<E>, context: ServiceContext<TAuth>): Promise<Patch<E>> =>
    hooks.beforeUpdate ? hooks.beforeUpdate({ id, patch, context }) : (patch as Patch<E>);

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
      const row = await repository.create(await toInsert(input, context), queryOptions(context));
      await hooks.afterCreate?.({ row, input, context });
      return row;
    },
    update: async (id, patch, context) => {
      const row = await repository.update(id, await toPatch(id, patch, context), queryOptions(context));
      await hooks.afterUpdate?.({ id, row, patch, context });
      return row;
    },
    delete: async (id, context) => {
      await hooks.beforeDelete?.({ id, context });
      const row = await repository.delete(id, queryOptions(context));
      await hooks.afterDelete?.({ id, row, context });
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
