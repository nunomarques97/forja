// Onion-style composition: each middleware gets (ctx, next) and may await next().
export function compose(middlewares) {
  return function run(ctx, last = async () => {}) {
    let index = -1;
    async function dispatch(i) {
      if (i <= index) throw new Error('next() called more than once');
      index = i;
      const fn = i === middlewares.length ? last : middlewares[i];
      return fn(ctx, () => dispatch(i + 1));
    }
    return dispatch(0);
  };
}
