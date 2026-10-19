# How `crudRoutes` infers its types

You usually call `crudRoutes` without any type arguments:

```ts
crudRoutes({ service: userService, context, authorize: { '*': requireAuth } });
```

TypeScript still works out three types from the options: the entity, the type of the current user, and the
full service type. This page explains how, for readers who don't use these TypeScript features every day.

The types live in `src/fastify/crud-routes.ts` (`crudRoutes`) and `src/fastify/options.ts`
(`CrudRoutesOptions`).

## The three type parameters

```ts
function crudRoutes<E extends CrudEntity<E>, TContext = undefined, S = CrudService<E, TContext>>(
  options: CrudRoutesOptions<E, TContext, S>,
): FastifyPluginAsync;

interface CrudRoutesOptions<E, TContext, S> {
  service: S & CrudServiceMethods<E, NoInfer<TContext>>;
  context?: ContextMapper<TContext>;
  authorize?: AuthorizeMap<TContext>;
  extend?: (scope: CrudScope, tools: CrudExtendTools<E, TContext, S>) => void | Promise<void>;
  // …
}
```

| Parameter | What it is | Where TypeScript gets it from |
|---|---|---|
| `E` | the entity from `defineEntity` | the service's `entity` property |
| `TContext` | the current user, as returned by `context` | `context` (and typed `authorize` rules), never the service |
| `S` | the exact type of the service you passed | the whole `service` value |

All three come from the single line `service: S & CrudServiceMethods<E, NoInfer<TContext>>`. The next sections
take it apart.

## The example used on this page

```ts
type User = { id: number; roles: string[] };

const userService = createService(userRepository).extend((base) => ({
  activate: (id: number, context: ServiceContext<User>) => base.update(id, { status: 'active' }, context),
}));

crudRoutes({
  service: userService,
  context: (request) => request.user ?? undefined, // returns User | undefined
  extend: (scope, { service, serviceContext }) => {
    service.activate; // must be typed here
  },
});
```

`userService` was created without an auth type, so its own methods take `ServiceContext<unknown>`. It also
has an extra `activate` method from `.extend()`.

## Why `S` captures the full service type

`S` stands on its own in the intersection (`S & …`). When TypeScript infers a type parameter that stands on
its own like that, it uses the whole type of the value passed in. So `S` becomes the exact type of
`userService`, including `activate`, the generated finders and the repository's custom methods.

`S` is then passed to `extend` as `tools.service`. That is why `service.activate` is typed inside `extend`.

Without `S`, the parameter would be typed as `CrudServiceMethods<E, TContext>` only, and `extend` would see just
the built-in methods. `activate` would be missing.

## Why the intersection lets TypeScript infer `E`

`S` alone says nothing about the entity. The other half, `CrudServiceMethods<E, …>`, does: it has a
`readonly entity: E` property. TypeScript matches the service's `entity` property against it and infers `E`.

An intersection means the value must satisfy both halves, so the service is also checked against the
built-in methods (`findMany`, `findById`, `create`, `update`, `delete`). Passing something that isn't a
service is still a compile error.

Only the built-in methods are checked, not the generated finders. They are enough to find `E` and to check
the auth type, and `S` already keeps the full type.

## Why `NoInfer` makes `TContext` come from `context`

`TContext` appears in two places: in `context` (`ContextMapper<TContext>`) and in the service's methods
(`ServiceContext<TContext>`). Without help, TypeScript would collect a guess from both places.

In the example the two guesses are `User` (from `context`) and `unknown` (from `userService`, which has no
auth type). TypeScript would pick `unknown`, so `context` in every `authorize` rule and in `serviceContext`
would lose its type.

`NoInfer<TContext>` tells TypeScript not to guess `TContext` from that spot. So `TContext` comes from `context` (and
from `authorize` rules, which are usually written to match it), and becomes `User`. The service is then
just checked against it:

- A service with no auth type takes `ServiceContext<unknown>`, which accepts any user, so it passes.
- A service created with a different auth type fails to compile, with the error on `service`:

```ts
const orgService = createService<typeof userEntity, { orgId: number }>(userRepository);
crudRoutes({ service: orgService, context: () => ({ orgId: 1 }) });     // ok
crudRoutes({ service: orgService, context: () => ({ orgId: 'one' }) }); // error: wrong auth type
```

When there is no `context` and no typed `authorize` rule, nothing tells TypeScript what `TContext` is, so it
uses the default, `undefined`.

## Where this is tested

`test/routes.test-d.ts` checks each case on this page: `TContext` inferred from `context`, an extended service
keeping its methods inside `extend`, and a mismatched auth type failing to compile. If you change the
`service` line in `options.ts`, run those tests.
