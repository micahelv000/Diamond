# How the finder types work

The finder methods (`findByStatus`, `findByStatusIn`, `findByScheduledDepartureBetween`, …) are not written
by hand. Their names and argument types are computed by TypeScript from the entity's `filterable` config.
This page explains how, one step at a time, for readers who don't use these TypeScript features every day.

The types live in `src/types.ts` (`RepositoryFinders` and its helpers) and `src/service/create-service.ts`
(`ServiceFinders`). The runtime code that actually creates the methods is `buildFinders` in
`src/repository/finders.ts`.

## The example used on this page

```ts
defineEntity(flights, {
  primaryKey: 'id',
  filterable: {
    id: ['eq', 'in'],
    status: ['eq', 'in'],
    scheduledDeparture: ['gte', 'lte'],
  },
});
```

The goal is to get these methods, with the right argument types:

| Method | Argument |
|---|---|
| `findByIdIn` | `number[]` |
| `findByStatus` | `'scheduled' \| 'boarding' \| …` |
| `findByStatusIn` | `('scheduled' \| 'boarding' \| …)[]` |
| `findByScheduledDepartureFrom` | `Date` |
| `findByScheduledDepartureUntil` | `Date` |
| `findByScheduledDepartureBetween` | `from: Date, to: Date` |

There is no `findById` finder, because the repository already has a built-in `findById`.

## Step 1: list every allowed filter (`FilterKey`)

```ts
type FilterKey<E> = {
  [K in keyof Filterable<E> & string]: `${K}__${KeysIn<Filterable<E>[K]>}`;
}[keyof Filterable<E> & string];
```

This turns the `filterable` object into one string per column and operator, like `'status__in'`. It uses
three features:

- **A mapped type** `{ [K in Keys]: … }` loops over every key and builds a new object type. Here it loops
  over the column names: `id`, `status`, `scheduledDeparture`.
- **A template literal type** `` `${K}__${Op}` `` builds a string type from other string types, like a
  template string at runtime. When `Op` is a union, it produces one string per member:
  `` `status__${'eq' | 'in'}` `` becomes `'status__eq' | 'status__in'`.
- **Indexed access with every key**: putting `[keyof …]` after the mapped type collects all its values
  into one union.

So after the mapped type we have:

```ts
{ id: 'id__eq' | 'id__in'; status: 'status__eq' | 'status__in'; scheduledDeparture: 'scheduledDeparture__gte' | 'scheduledDeparture__lte' }
```

and after `[keyof …]`:

```ts
'id__eq' | 'id__in' | 'status__eq' | 'status__in' | 'scheduledDeparture__gte' | 'scheduledDeparture__lte'
```

`KeysIn` is a small helper that turns the operator array from the config (`readonly ['eq', 'in']`) into a
union (`'eq' | 'in'`).

## Step 2: turn each filter into a method name (`FinderName`)

```ts
type FinderName<E, P> = P extends `${infer K}__${infer O extends FilterOperator}`
  ? O extends 'eq'
    ? K extends PrimaryKey<E> ? never : `findBy${Capitalize<K>}`
    : `findBy${Capitalize<K>}${FinderSuffix[O]}`
  : never;
```

This reads a key like `'status__in'` and returns `'findByStatusIn'`.

- **`infer` inside a template literal** pulls a string apart, like a regex with capture groups.
  `` P extends `${infer K}__${infer O}` `` splits `'status__in'` into `K = 'status'` and `O = 'in'`.
- **A conditional type** `A extends B ? X : Y` is an if/else on types.
- **`Capitalize`** is built into TypeScript: `Capitalize<'status'>` is `'Status'`.
- **`FinderSuffix[O]`** looks up the suffix for the operator: `in → 'In'`, `ilike → 'Containing'`,
  `gte → 'From'`, `lte → 'Until'`, and `eq → ''`.
- **`never`** means "no name". In the next step, a key renamed to `never` is dropped from the object. That
  is how the primary key's `eq` finder disappears: `'id__eq'` becomes `never`.

## Step 3: work out the argument type (`FilterValue`)

```ts
type FilterValue<E, P> = P extends `${infer K}__in`
  ? ColumnValue<E, K>[]
  : P extends `${string}__ilike`
    ? string
    : P extends `${infer K}__${FilterOperator}`
      ? ColumnValue<E, K>
      : never;
```

This is another chain of conditional types with `infer`:

- `__in` takes an array of the column's type.
- `__ilike` takes a string.
- Every other operator takes the column's own type.

`ColumnValue<E, K>` reads the column's type from Drizzle's `$inferSelect` and removes `null`.

## Step 4: build the methods (key remapping with `as`)

```ts
type ServiceValueFinders<E, TAuth> = {
  [P in FilterKey<E> as FinderName<E, P>]: ServiceFinder<E, TAuth, FilterValue<E, P>>;
};
```

This is a mapped type with **key remapping**: `[P in Keys as NewName]`. It loops over every filter key `P`
from step 1, renames it to `FinderName<E, P>` from step 2, and gives it a method type using
`FilterValue<E, P>` from step 3. Keys renamed to `never` are dropped.

For the example this produces:

```ts
{
  findByIdIn: ServiceFinder<…, number[]>;
  findByStatus: ServiceFinder<…, 'scheduled' | 'boarding' | …>;
  findByStatusIn: ServiceFinder<…, ('scheduled' | 'boarding' | …)[]>;
  findByScheduledDepartureFrom: ServiceFinder<…, Date>;
  findByScheduledDepartureUntil: ServiceFinder<…, Date>;
}
```

## Step 5: add the range finders (`RangeKey` and `BetweenFinderName`)

```ts
type RangeKey<E> = {
  [K in keyof Filterable<E> & string]: 'gte' | 'lte' extends KeysIn<Filterable<E>[K]> ? K : never;
}[keyof Filterable<E> & string];
```

This uses the same pattern as step 1 to find the columns that declare **both** `gte` and `lte`.
`'gte' | 'lte' extends X` is true only when `X` contains both. Columns that don't qualify become `never`
and vanish from the union. For the example, `RangeKey` is just `'scheduledDeparture'`.

```ts
type BetweenFinderName<C> = `findBy${Capitalize<C>}Between`;

type ServiceRangeFinders<E, TAuth> = {
  [C in RangeKey<E> as BetweenFinderName<C>]: ServiceRangeFinder<E, TAuth, RangeValue<E, C>>;
};
```

This gives `findByScheduledDepartureBetween(from: Date, to: Date, …)`.

## Step 6: combine them

```ts
type ServiceFinders<E, TAuth> = ServiceValueFinders<E, TAuth> & ServiceRangeFinders<E, TAuth>;
```

`&` (an intersection) merges the two objects into one with all the methods. `RepositoryFinders` is built
the same way. The only difference is that repository finders take no `ctx` argument.

## What a single finder looks like (`ServiceFinder`)

```ts
type ServiceFinder<E, TAuth, Value> = [Value] extends [unknown]
  ? <K extends VisibleKey<E> = VisibleKey<E>>(
      value: Value,
      ctx: ServiceContext<TAuth>,
      options?: ListOptions<E, K>,
    ) => Promise<ListResult<E, K>>
  : never;
```

Two details are worth explaining.

**The `<K …>` generic** makes the `columns` option narrow the result. If you call
`findByStatusIn([...], ctx, { columns: ['id', 'flightNumber'] })`, TypeScript infers `K` as
`'id' | 'flightNumber'`, and each returned row only has those two fields. Without `columns`, `K` defaults to
every visible column.

**`[Value] extends [unknown] ? … : never` is always true.** It changes nothing about the type. It is only
there for editor hovers. When a type alias is used directly, editors show its name, so hovering a finder
would show `ServiceFinder<Entity<…a very long table type…>, …>` and hide the parameter names. A conditional
type gets resolved first, so the hover shows the actual function: `(value: …, ctx: …, options?: …) => …`.

The brackets around `Value` matter. Without them, a conditional type is checked once for each member of a
union, so for a column whose type is `'scheduled' | 'boarding'`, the result would become a union of several
functions instead of one function that takes either value.

## Keeping the types and the runtime in sync

The types only describe the methods. `buildFinders` in `src/repository/finders.ts` creates them at runtime
with the same rules:

- the same names, built from the same suffix table (typed as `FinderSuffix`, so a mismatch is a compile error)
- no `eq` finder for the primary key
- a `Between` finder only when a column has both `gte` and `lte`

If you change a naming rule, change both places. The tests in `test/finders.test.ts` (runtime) and
`test/finders.test-d.ts` (types) check that they agree.
