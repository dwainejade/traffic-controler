import type { LevelDef } from "../../sim/types";

/**
 * The app's side of the world store.
 *
 * Everything here is optional. The store is a local process holding a borough
 * that somebody chose to ingest, and the app has to work exactly as it always
 * did when it is not running — so every function in this file answers "not
 * there" rather than throwing, and the importer falls back to OpenStreetMap.
 *
 * What the store buys is the difference between an area costing a round trip to
 * a public server per 1.8km of ground — nine of them and several minutes for a
 * 5km box — and costing one gzipped download of a level that is already
 * compiled. The browser does no importing at all on that path.
 */

/**
 * Same origin in development, where Vite proxies `/api` to the store. A built
 * app pointed at a store elsewhere sets `VITE_WORLD_DB` to its base URL.
 */
const BASE = import.meta.env.VITE_WORLD_DB ?? "/api";

/**
 * How long the store gets to answer a probe.
 *
 * Short, because this runs on the path to the import form and its *failure* is
 * the common case — most people will never run the store, and they should not
 * wait to find that out. A level download has no such limit; that one is worth
 * waiting for.
 */
const PROBE_TIMEOUT_MS = 1_500;

export type DbArea = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Half the square's side, in metres. */
  radius: number;
  builtAt: number;
  /** Compressed size of the level, for a download this size being worth saying. */
  bytes: number;
};

/**
 * Whether the store answered, remembered for the session.
 *
 * A promise rather than a boolean so the several callers that want to know at
 * once share one probe instead of racing four of them, and `null` so a store
 * started *after* the app can still be picked up by a reload.
 */
let probe: Promise<DbArea[] | null> | null = null;

/**
 * Ask the store what it has, once per session.
 *
 * `areas.json` rather than a health endpoint, because it is the one request
 * that works against both shapes of store — a running server and a bucket full
 * of files. A bucket has no `/health` to answer, and giving the two stores
 * different probes would mean the CDN path was never exercised in development.
 *
 * It doubles as the listing, so knowing the store exists and knowing what is in
 * it are the same round trip.
 */
function index(): Promise<DbArea[] | null> {
  probe ??= (async () => {
    try {
      const res = await fetch(`${BASE}/areas.json`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { areas?: DbArea[] };
      return body.areas ?? [];
    } catch {
      return null;
    }
  })();
  return probe;
}

export async function isAvailable(): Promise<boolean> {
  return (await index()) !== null;
}

/** Forget the probe, so the next call asks again. For the dev console. */
export function recheck(): void {
  probe = null;
}

/**
 * Areas baked into the store, or an empty list if there is no store.
 *
 * Empty rather than an error on every failure. A missing store is the normal
 * case and not a problem to report; the level list simply has nothing extra in
 * it, which is exactly what it looked like before any of this existed.
 */
export async function listDbAreas(): Promise<DbArea[]> {
  return (await index()) ?? [];
}

/**
 * A response body that may or may not still be gzipped, as JSON.
 *
 * Whether a `.json.gz` arrives compressed depends on something outside this
 * app's control: a CDN configured with `Content-Encoding: gzip` has the browser
 * decompress it before we ever see it, and a bucket serving the file as-is does
 * not. That is per-host configuration, it is easy to get wrong, and getting it
 * wrong would otherwise mean a deploy that 200s on every request and fails to
 * parse every one of them.
 *
 * So sniff it. The two leading bytes of a gzip member are 0x1f 0x8b, which no
 * JSON document can begin with — a valid body starts with `{`. Cheap, exact,
 * and it makes the upload instructions one line shorter.
 */
async function decode<T>(res: Response): Promise<T> {
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;

  if (!gzipped) return JSON.parse(new TextDecoder().decode(buf)) as T;

  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

export type DbLevelRequest = {
  /** The id the level must carry — the app owns level ids, not the store. */
  levelId: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
};

/**
 * A compiled level from the store, or null if it does not have that ground.
 *
 * Null covers both "no store running" and "store running, area not ingested",
 * because the caller does the same thing with either: fetch it from
 * OpenStreetMap the long way. A store that is up but *broken* throws, since that
 * is worth seeing rather than papering over with a three-minute import.
 */
export async function fetchDbLevel(
  req: DbLevelRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<LevelDef | null> {
  if (!(await isAvailable())) return null;

  const url = new URL(`${BASE}/level`, window.location.origin);
  url.searchParams.set("levelId", req.levelId);
  url.searchParams.set("name", req.name);
  url.searchParams.set("lat", String(req.lat));
  url.searchParams.set("lon", String(req.lon));
  url.searchParams.set("radius", String(req.radius));

  const res = await fetch(url, { signal: opts.signal });

  /*
   * Any refusal is "the store cannot give me this box", and the caller's answer
   * to that is always the same: fetch it from OpenStreetMap. A static store has
   * no compiler behind it and refuses *every* such request — as a 404 from a
   * bucket, a 403 from a locked-down one, or whatever a CDN substitutes — so
   * singling out 404 here would turn the ordinary CDN case into a thrown error.
   */
  if (!res.ok) return null;
  return await decode<LevelDef>(res);
}

/**
 * A baked area by id.
 *
 * `levels/<id>.json.gz` is a path rather than a query, because on a static store
 * it is literally a file. Null if the store has lost it, which means the listing
 * this id came from is stale — the caller says so and offers a refresh.
 */
export async function fetchDbArea(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<LevelDef | null> {
  if (!(await isAvailable())) return null;

  const res = await fetch(`${BASE}/levels/${encodeURIComponent(id)}.json.gz`, {
    signal: opts.signal,
  });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`world store answered ${res.status}`);
  return await decode<LevelDef>(res);
}
