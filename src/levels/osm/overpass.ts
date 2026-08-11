import type { OsmFile } from "./import";

/**
 * Asking OpenStreetMap for a square of city.
 *
 * Shared by `tools/fetchOsm.ts`, which caches an area into the repo, and by the
 * in-app importer, which fetches one straight into the browser. The query in
 * particular has to be the same in both: a tag added on one side and not the
 * other is a silent divergence between the areas that ship and the areas you
 * import, invisible until someone wonders why their park has no grass in it.
 */

export type Bbox = { south: number; west: number; north: number; east: number };

/** Metres per degree at a given latitude. Good to a centimetre at this scale. */
export function scaleAt(lat: number): { perLat: number; perLon: number } {
  return {
    perLat: 111132.92 - 559.82 * Math.cos((2 * lat * Math.PI) / 180),
    perLon: 111412.84 * Math.cos((lat * Math.PI) / 180),
  };
}

/** `metres` is half the square's side, so 300 gives a 600m box. */
export function boxAround(lat: number, lon: number, metres: number): Bbox {
  const { perLat, perLon } = scaleAt(lat);
  return {
    south: lat - metres / perLat,
    north: lat + metres / perLat,
    west: lon - metres / perLon,
    east: lon + metres / perLon,
  };
}

/*
 * The main Overpass instance is frequently too busy and answers 504 rather than
 * queueing, so try the public mirrors in turn.
 *
 * Order matters more from the browser than from the CLI. Measured from a page
 * on localhost: overpass-api.de answers in about a second and kumi.systems in
 * about thirteen, private.coffee often does not answer inside twenty, and
 * osm.jp sends no CORS headers at all so the request fails immediately and
 * always. The last two stay as a backstop for the CLI, which has no such
 * restriction, and the per-attempt timeout below keeps a hung one cheap.
 */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
] as const;

/**
 * How long one mirror gets before we move on.
 *
 * The query's own `timeout:90` is the server's budget for running it; this is
 * ours for waiting. A mirror that has said nothing in a minute is not about to,
 * and there is another one right behind it.
 */
const ATTEMPT_TIMEOUT_MS = 60_000;

/*
 * Three sets, one query:
 *   - the driveable street network, with `>` to pull in each way's nodes so we
 *     have coordinates and can spot shared nodes (which is what an intersection
 *     *is* in OSM — ways that share a node, not ways that merely cross);
 *   - traffic signals and crossings, as tagged nodes;
 *   - buildings, water and green space, for real footprints instead of scatter.
 *
 * `way(bbox)` returns whole ways that merely touch the box, so the geometry
 * runs past the edges; the importer clips it and puts sources on the boundary.
 */
export function overpassQuery(bbox: Bbox): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${box});
);
out body;
>;
out skel qt;

node["highway"~"^(traffic_signals|crossing|stop|give_way)$"](${box});
out body;

(
  way["building"](${box});
  way["natural"="water"](${box});
  way["leisure"~"^(park|pitch|garden)$"](${box});
  way["landuse"~"^(grass|cemetery|recreation_ground)$"](${box});
);
out body;
>;
out skel qt;
`;
}

export type FetchProgress =
  | { phase: "trying"; endpoint: string; index: number; total: number }
  | { phase: "failed"; endpoint: string; error: string }
  | { phase: "received"; bytes: number };

export type FetchOptions = {
  endpoints?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (p: FetchProgress) => void;
  /**
   * Node only. Overpass rejects a request with no User-Agent outright (406)
   * rather than serving it anonymously, so the CLI must send one.
   *
   * A browser always sends its own, and `User-Agent` is a forbidden header
   * name in `fetch` — setting it is dropped silently, and any non-safelisted
   * header would turn this POST into a preflighted request, which not every
   * mirror answers. So the browser must not pass this.
   */
  userAgent?: string;
};

export class OverpassError extends Error {
  attempts: { endpoint: string; error: string }[];

  constructor(message: string, attempts: { endpoint: string; error: string }[] = []) {
    super(message);
    this.name = "OverpassError";
    this.attempts = attempts;
  }
}

/** Cleaned up for a one-line log or an error list. */
function reason(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

async function ask(
  endpoint: string,
  query: string,
  opts: FetchOptions,
): Promise<OsmFile> {
  /*
   * Two ways to give up: the caller cancelling, and this mirror taking too
   * long. `AbortSignal.any` is what merges them — aborting the timeout on the
   * way out matters, or a fast success still leaves a minute-long timer behind
   * for every mirror we ever tried.
   */
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ATTEMPT_TIMEOUT_MS);
  const signals = [timeout.signal, ...(opts.signal ? [opts.signal] : [])];

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(opts.userAgent ? { "User-Agent": opts.userAgent } : {}),
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    // Our own timeout is this mirror failing, not the player cancelling; only
    // the caller's signal should abort the whole import.
    if (timeout.signal.aborted && !opts.signal?.aborted) {
      throw new Error(`no answer in ${ATTEMPT_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const text = await res.text();
  opts.onProgress?.({ phase: "received", bytes: text.length });
  const json = JSON.parse(text) as OsmFile & { remark?: string };

  /*
   * A 200 is not a success. Overpass answers a query that ran out of time or
   * memory with HTTP 200 and a `remark`, plus however many elements it managed
   * — which imports as a city with holes in it. Treat it as this mirror
   * failing, and let the next one try.
   */
  if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
    throw new Error(json.remark);
  }
  return json;
}

/**
 * Fetch a box, trying each mirror in turn. Throws `OverpassError` listing what
 * every mirror said if none of them answers.
 */
export async function fetchOverpass(
  bbox: Bbox,
  opts: FetchOptions = {},
): Promise<OsmFile> {
  const query = overpassQuery(bbox);
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const attempts: { endpoint: string; error: string }[] = [];

  for (const [i, endpoint] of endpoints.entries()) {
    opts.onProgress?.({
      phase: "trying",
      endpoint,
      index: i,
      total: endpoints.length,
    });
    try {
      const json = await ask(endpoint, query, opts);
      // The importer projects to local metres about the box centre, and nothing
      // else in the response says where on earth it is.
      json.bbox = bbox;
      return json;
    } catch (err) {
      // An abort is the user's decision, not a mirror being down.
      if (err instanceof Error && err.name === "AbortError") throw err;
      const error = reason(err);
      attempts.push({ endpoint, error });
      opts.onProgress?.({ phase: "failed", endpoint, error });
    }
  }

  throw new OverpassError("every OpenStreetMap mirror refused", attempts);
}
