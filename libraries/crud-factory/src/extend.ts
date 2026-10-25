import { mapDatabaseError } from './errors.ts';

/**
 * Wraps methods added with `extend` so their rejected promises go through `mapDatabaseError`, giving
 * constraint violations the same 409/400 errors as the base methods instead of a 500.
 * `this`, the arguments and non-promise results pass through untouched.
 */
function withMappedErrors<X extends object>(methods: X): X {
  // Copies every own property first, symbol keys included, then replaces the functions.
  const wrapped: Record<PropertyKey, unknown> = {};
  Object.assign(wrapped, methods);
  for (const [key, method] of Object.entries(methods)) {
    if (typeof method !== 'function') continue;
    wrapped[key] = function (this: unknown, ...args: unknown[]): unknown {
      const result: unknown = method.apply(this, args);
      // Drizzle query builders aren't promises but have `then`, so `Promise.resolve` runs them and catches their errors.
      if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((error: unknown) => {
          throw mapDatabaseError(error);
        });
      }
      return result;
    };
  }
  // Every key of `X` is still there, and each wrapper takes the same arguments and `this` and returns
  // the same result, so the object still matches `X`.
  return wrapped as X;
}

/**
 * Returns `methods` plus the methods added with `extend`, with their database errors mapped.
 *
 * The repository and the service each have a small recursive `build<X>`, where `X` holds the types of all
 * methods added so far. `extend<Y>` calls `build<X & Y>(withExtend(methods, added))`, so chained calls keep
 * the earlier types. `NoOverride` in the public `extend` types blocks base names. `build` itself is written
 * in each layer because its return type depends on `X`, which TypeScript can't abstract over without casts.
 */
export function withExtend<M extends object, Y extends object>(methods: M, added: Y): M & Y {
  return { ...methods, ...withMappedErrors(added) };
}
