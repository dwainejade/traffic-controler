/**
 * The resolve hook itself. Runs on Node's loader thread; see `tsResolve.mjs`.
 */

/**
 * What an extensionless relative specifier might have meant, in the order a
 * bundler would try them. `.tsx` is in the list because `src/` mixes the two and
 * a future `sim/` module could be either; `/index.ts` because `./store` and
 * `./osm` are both directories with one.
 */
const CANDIDATES = [".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    /*
     * Only ever a fallback, and only for the one failure it can fix. Guessing
     * ahead of Node would shadow real files; guessing on any error at all would
     * turn a syntax error deep in a module into a confusing "not found" for its
     * importer.
     */
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) throw err;

    for (const ext of CANDIDATES) {
      try {
        return await next(specifier + ext, context);
      } catch {
        /* Try the next shape. */
      }
    }
    throw err;
  }
}
