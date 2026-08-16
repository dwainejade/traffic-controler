import { register } from "node:module";

/**
 * Let Node resolve the app's imports.
 *
 * Everything under `src/` is written for a bundler and imports without an
 * extension — `./import`, `../../sim/types`. Node's ESM resolver requires the
 * real filename, so importing any of it from a Node process fails on the first
 * hop with ERR_MODULE_NOT_FOUND.
 *
 * The alternative was to write extensions throughout `src/`, which is a hundred
 * files edited so that two Node entry points can start, and a rule every future
 * import has to remember. This is the same job in one hook.
 *
 * Node strips the types itself (24.x, no flag), so nothing here compiles
 * anything — this only answers "which file did they mean".
 *
 * Used as:  node --import ./tools/tsResolve.mjs <entry>
 */
register("./tsResolve.hooks.mjs", import.meta.url);
