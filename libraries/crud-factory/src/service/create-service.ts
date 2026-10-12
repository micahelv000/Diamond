import type { SQL } from 'drizzle-orm';
import { CrudFactoryError } from '../errors.ts';
import { withMappedErrors } from '../repository/create-repository.ts';
import { buildFinders } from '../repository/finders.ts';
import type { CrudRepository } from '../repository/types.ts';
import type {
  AnyEntity,
  CreateInput,
  Database,
  FilterKey,
  FilterValue,
  FinderName,
  Insert,
  FindByIdOptions,
  ListOptions,
  ListResult,
  Logger,
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
  /** The logger to write to. In a route, pass the request's logger so logs include the request id. */
  log: Logger;
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
 * When `ctx.tx` is set, as in routes by default, a hook that throws rolls back the write. Work done outside
 * the database, such as sending emails or events, can't be rolled back.
 */
export interface ServiceHooks<E extends AnyEntity, TAuth> {
  /**
   * Runs before every create. Receives the client's input and returns the full row to insert, so it can
   * set columns that clients may not send. Throw to reject the request.
   */
  beforeCreate?(args: { input: CreateInput<E>; ctx: ServiceContext<TAuth> }): Insert<E> | Promise<Insert<E>>;
  /** Runs after every create succeeds, with the saved row and the client's input. Its return value is ignored. */
  afterCreate?(args: { row: Row<E>; input: CreateInput<E>; ctx: ServiceContext<TAuth> }): void;
  /** Runs before every update. Receives the id and the client's changes, and returns the changes to save. Throw to reject the request. */
  beforeUpdate?(args: {
    id: PrimaryKeyValue<E>;
    patch: UpdateInput<E>;
    ctx: ServiceContext<TAuth>;
  }): Patch<E> | Promise<Patch<E>>;
  /** Runs after every update succeeds, with the saved row and the client's changes. Its return value is ignored. */
  afterUpdate?(args: { id: PrimaryKeyValue<E>; row: Row<E>; patch: UpdateInput<E>; ctx: ServiceContext<TAuth> }): void;
  /**
   * Runs before every delete. Throw to block it. It receives only the id; to check the row, read it
   * with the repository, passing `ctx.tx` and `ctx.scope`.
   */
  beforeDelete?(args: { id: PrimaryKeyValue<E>; ctx: ServiceContext<TAuth> }): void;
  /** Runs after every delete succeeds, soft or hard, with the deleted row. Its return value is ignored. */
  afterDelete?(args: { id: PrimaryKeyValue<E>; row: Row<E>; ctx: ServiceContext<TAuth> }): void;
}

/** Options for `createService`. */
export interface ServiceOptions<E extends AnyEntity, TAuth> {
  /** Functions that run before and after each create, update and delete. */
  hooks?: ServiceHooks<E, TAuth>;
}

// The signatures are written out inline, not as a named type, so editor hovers show the real parameter types.
/**
 * Finder methods generated from the entity's `filterable` columns. They match the repository finders but
 * take a `ctx` after the value(s), and run through the service's `findMany`, so logging, scope, soft delete
 * and the transaction all apply. `options` accepts everything `findMany` does; its `where` is ANDed with the finder's condition.
 */
export type ServiceFinders<E extends AnyEntity, TAuth = unknown> = {
  [P in FilterKey<E> as FinderName<E, P>]: <K extends VisibleKey<E> = VisibleKey<E>>(
    value: FilterValue<E, P>,
    ctx: ServiceContext<TAuth>,
    options?: ListOptions<E, K>,
  ) => Promise<ListResult<E, K>>;
} & {
  [C in RangeKey<E> as `findBy${Capitalize<C>}Between`]: <K extends VisibleKey<E> = VisibleKey<E>>(
    from: RangeValue<E, C>,
    to: RangeValue<E, C>,
    ctx: ServiceContext<TAuth>,
    options?: ListOptions<E, K>,
  ) => Promise<ListResult<E, K>>;
};

/**
 * The built-in service: the CRUD methods, the generated finders, the entity and the repository.
 * `R` is the repository's type, so its custom methods stay typed on `repository`.
 */
export type CrudServiceBase<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>> =
  CrudServiceMethods<E, TAuth, R> & ServiceFinders<E, TAuth>;

/** The entity, the repository and the CRUD methods that every service has. */
export interface CrudServiceMethods<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>> {
  readonly entity: E;
  /** The wrapped repository, including its custom methods. Calls made on it skip the service's hooks and logging. */
  readonly repository: R;
  findMany<K extends VisibleKey<E> = VisibleKey<E>>(options: ListOptions<E, K>, ctx: ServiceContext<TAuth>): Promise<ListResult<E, K>>;
  findById<K extends VisibleKey<E> = VisibleKey<E>>(
    id: PrimaryKeyValue<E>,
    options: FindByIdOptions<K>,
    ctx: ServiceContext<TAuth>,
  ): Promise<Pick<Row<E>, K> | null>;
  create(input: CreateInput<E>, ctx: ServiceContext<TAuth>): Promise<Row<E>>;
  update(id: PrimaryKeyValue<E>, patch: UpdateInput<E>, ctx: ServiceContext<TAuth>): Promise<Row<E>>;
  delete(id: PrimaryKeyValue<E>, ctx: ServiceContext<TAuth>): Promise<Row<E>>;
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
     * so far, and reusing a built-in name is a compile error. Pass a `ctx` through to the `base` methods
     * so that hooks, logging, scope and the transaction apply.
     */
    extend<Y extends object>(
      factory: (base: CrudService<E, TAuth, R, X>) => Y & NoOverride<keyof CrudServiceBase<E, TAuth, R> | 'extend'>,
    ): CrudService<E, TAuth, R, X & Y>;
  };

type ServiceMethod = 'findMany' | 'findById' | 'create' | 'update' | 'delete';

/**
 * Wraps a repository with hooks and logging. Only ids and timings are logged, never values.
 * If you pass type arguments yourself, pass the repository's type third to keep its custom methods typed.
 */
export function createService<E extends AnyEntity, TAuth = unknown, R extends CrudRepository<E> = CrudRepository<E>>(
  // The intersection lets TypeScript infer `E` from `CrudRepository<E>` and the full repository type from `R`.
  repository: R & CrudRepository<E>,
  options: ServiceOptions<E, TAuth> = {},
): CrudService<E, TAuth, R> {
  const { hooks = {} } = options;
  const entity = repository.entity.name;

  async function logged<R>(op: ServiceMethod, ctx: ServiceContext<TAuth>, id: unknown, call: () => Promise<R>): Promise<R> {
    const started = performance.now();
    try {
      const result = await call();
      ctx.log.debug({ entity, op, id, durationMs: Math.round(performance.now() - started) }, 'repository call');
      return result;
    } catch (error) {
      if (error instanceof CrudFactoryError) {
        // Client errors (4xx) are logged at debug level so they don't trigger alerts.
        const level = error.statusCode < 500 ? 'debug' : 'warn';
        ctx.log[level]({ entity, op, id, code: error.code, durationMs: Math.round(performance.now() - started) }, error.message);
      }
      throw error;
    }
  }

  // Passing the logger down makes the repository's SQL logs use the caller's logger and request id.
  const queryOptions = (ctx: ServiceContext<TAuth>): QueryOptions => ({ tx: ctx.tx, scope: ctx.scope, log: ctx.log });
  // Without a hook the input is inserted as-is, so omitted columns must have database defaults.
  // The casts are needed because TypeScript can't relate the two `Omit` types over a generic table.
  const toInsert = async (input: CreateInput<E>, ctx: ServiceContext<TAuth>): Promise<Insert<E>> =>
    hooks.beforeCreate ? hooks.beforeCreate({ input, ctx }) : (input as Insert<E>);
  // `UpdateInput` is a subset of `Patch`, so this cast is safe.
  const toPatch = async (id: PrimaryKeyValue<E>, patch: UpdateInput<E>, ctx: ServiceContext<TAuth>): Promise<Patch<E>> =>
    hooks.beforeUpdate ? hooks.beforeUpdate({ id, patch, ctx }) : (patch as Patch<E>);

  const findMany: CrudServiceMethods<E, TAuth, R>['findMany'] = (listOptions, ctx) =>
    logged('findMany', ctx, undefined, () => repository.findMany({ ...listOptions, ...queryOptions(ctx) }));

  const service: CrudServiceBase<E, TAuth, R> = {
    entity: repository.entity,
    repository,
    findMany,
    ...buildFinders<ServiceFinders<E, TAuth>, [ctx: ServiceContext<TAuth>, options?: ListOptions<E>]>(
      repository.entity,
      (where, [ctx, options = {}]) => findMany({ ...options, where: where(options.where) }, ctx),
    ),
    findById: (id, findOptions, ctx) =>
      logged('findById', ctx, id, () => repository.findById(id, { ...findOptions, ...queryOptions(ctx) })),
    // The hooks run inside `logged`, so their errors are logged like the write's own.
    create: (input, ctx) =>
      logged('create', ctx, undefined, async () => {
        const row = await repository.create(await toInsert(input, ctx), queryOptions(ctx));
        await hooks.afterCreate?.({ row, input, ctx });
        return row;
      }),
    update: (id, patch, ctx) =>
      logged('update', ctx, id, async () => {
        const row = await repository.update(id, await toPatch(id, patch, ctx), queryOptions(ctx));
        await hooks.afterUpdate?.({ id, row, patch, ctx });
        return row;
      }),
    delete: (id, ctx) =>
      logged('delete', ctx, id, async () => {
        await hooks.beforeDelete?.({ id, ctx });
        const row = await repository.delete(id, queryOptions(ctx));
        await hooks.afterDelete?.({ id, row, ctx });
        return row;
      }),
  };

  // `X` accumulates the types of added methods, so chained `extend` calls keep earlier ones.
  const build = <X extends object>(methods: CrudServiceBase<E, TAuth, R> & X): CrudService<E, TAuth, R, X> => {
    const current: CrudService<E, TAuth, R, X> = {
      ...methods,
      extend: <Y extends object>(factory: (base: CrudService<E, TAuth, R, X>) => Y) => build<X & Y>({ ...methods, ...withMappedErrors(factory(current)) }),
    };
    return current;
  };
  return build(service);
}
