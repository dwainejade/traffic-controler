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
 * The order to try from a browser.
 *
 * Two differences from the list above, both learned the hard way. `osm.jp`
 * sends no CORS headers, so from a page it fails instantly and always — it is
 * only ever a waste of an attempt. And the main instance is both the fastest by
 * a wide margin and the one that sheds load by answering 504, so the best use
 * of the second attempt is to ask it again rather than to start queueing behind
 * a slower mirror.
 */
export const BROWSER_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

/**
 * The server's own budget for running the query, in seconds.
 *
 * Deliberately well under what a legitimate box needs — the largest area this
 * app will ask for, six hundred metres of midtown Manhattan, comes back in
 * fifteen seconds. So a query that reaches this limit is not slow, it is too
 * big, and the server saying so is a far better error than us guessing.
 */
const QUERY_TIMEOUT_S = 60;

/**
 * How long one mirror gets before we move on.
 *
 * This has to be *longer* than the query timeout above, or we cut off queries
 * the server was about to answer and then repeat the mistake on every mirror in
 * turn — which is exactly how a failed import came to take four minutes and
 * report nothing more useful than "every mirror is busy".
 */
const ATTEMPT_TIMEOUT_MS = (QUERY_TIMEOUT_S + 10) * 1000;

/**
 * The whole import's deadline, mirrors and retries included.
 *
 * A hard ceiling, not a check between attempts: each attempt gets whatever is
 * left of it, so the total cannot overrun by a straggler. Four minutes of
 * waiting followed by "every mirror is busy" is a worse answer than the same
 * message two minutes sooner.
 */
const TOTAL_BUDGET_MS = 120_000;

/** Not worth starting an attempt with less than this left. */
const MIN_ATTEMPT_MS = 15_000;

/** Pause before asking a mirror that has just turned us away. */
const RETRY_DELAY_MS = 2_500;

/*
 * Three sets, one query:
 *   - the driveable street network, with `>` to pull in each way's nodes so we
 *     have coordinates and can spot shared nodes (which is what an intersection
 *     *is* in OSM — ways that share a node, not ways that merely cross);
 *   - traffic signals and crossings, as tagged nodes;
 *   - buildings, water (closed ponds/rivers and open sea coastlines) and green
 *     space, for real footprints instead of scatter.
 *
 * `way(bbox)` returns whole ways that merely touch the box, so the geometry
 * runs past the edges; the importer clips it and puts sources on the boundary.
 */
export function overpassQuery(bbox: Bbox): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:${QUERY_TIMEOUT_S}];
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
  way["natural"="coastline"](${box});
  way["leisure"~"^(park|pitch|garden)$"](${box});
  way["landuse"~"^(grass|cemetery|recreation_ground)$"](${box});
);
out body;
>;
out skel qt;
`;
}

export type FetchProgress =
  | { phase: "trying"; endpoint: string; index: number; total: number; retry: boolean }
  | { phase: "failed"; endpoint: string; error: string }
  | { phase: "received"; bytes: number };

/**
 * Why an attempt failed, which is what decides the message somebody sees.
 *
 * `busy` is the mirror shedding load and says nothing about the request — 504
 * and 429 both mean "not now", and the same query a minute later usually
 * works. `tooBig` is the opposite: the server ran the query and gave up on it,
 * so asking a different mirror will fail in exactly the same way.
 */
export type FailureKind = "busy" | "tooBig" | "unreachable";

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

export type Attempt = { endpoint: string; error: string; kind: FailureKind };

export class OverpassError extends Error {
  attempts: Attempt[];

  constructor(message: string, attempts: Attempt[] = []) {
    super(message);
    this.name = "OverpassError";
    this.attempts = attempts;
  }
}

/**
 * An attempt failure that knows what kind it was.
 *
 * A plain Error would do, except that the only thing worth telling somebody
 * about a failed import is which of these happened, and reconstructing it by
 * matching on message text is how the old "every mirror is busy" came to be
 * printed over a query that was simply too large.
 */
class AttemptError extends Error {
  kind: FailureKind;

  constructor(message: string, kind: FailureKind) {
    super(message);
    this.name = "AttemptError";
    this.kind = kind;
  }
}

/** Cleaned up for a one-line log or an error list. */
function reason(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(
  endpoint: string,
  query: string,
  opts: FetchOptions,
  budgetMs: number,
): Promise<OsmFile> {
  /*
   * Two ways to give up: the caller cancelling, and this mirror taking too
   * long. `AbortSignal.any` is what merges them — aborting the timeout on the
   * way out matters, or a fast success still leaves a minute-long timer behind
   * for every mirror we ever tried.
   */
  const limit = Math.min(ATTEMPT_TIMEOUT_MS, budgetMs);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), limit);
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
      throw new AttemptError(`no answer in ${Math.round(limit / 1000)}s`, "busy");
    }
    if (err instanceof Error && err.name === "AbortError") throw err;
    // A fetch that rejects outright reached nothing: DNS, TLS, or — the usual
    // one here — a mirror that serves no CORS headers to a browser.
    throw new AttemptError(reason(err), "unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    /*
     * 504 is how the main instance sheds load rather than queueing, and 429 is
     * the rate limiter. Both mean "not now" and neither says anything about the
     * query, so both are worth retrying.
     */
    const busy = res.status === 504 || res.status === 429 || res.status === 503;
    throw new AttemptError(
      `${res.status} ${(await res.text()).slice(0, 200)}`,
      busy ? "busy" : "unreachable",
    );
  }

  /*
   * Reading the body can fail on its own account. A box big enough to answer
   * with half a gigabyte overflows the maximum string length, and that is the
   * request being too large — not the network, which did its job.
   */
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new AttemptError(`response too large to read (${reason(err)})`, "tooBig");
  }
  opts.onProgress?.({ phase: "received", bytes: text.length });
  const json = JSON.parse(text) as OsmFile & { remark?: string };

  /*
   * A 200 is not a success. Overpass answers a query that ran out of time or
   * memory with HTTP 200 and a `remark`, plus however many elements it managed
   * — which imports as a city with holes in it. Treat it as this mirror
   * failing, and let the next one try.
   */
  if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
    // The server ran it and gave up. Another mirror will do the same.
    throw new AttemptError(json.remark, "tooBig");
  }
  return json;
}

/**
 * Fetch a box, working down the mirror list. Throws `OverpassError` carrying
 * what each attempt said if none of them answers.
 *
 * The list may name the same mirror twice, which is the point: the main
 * instance answers 504 when it is loaded rather than making you queue, and
 * asking it again a couple of seconds later beats waiting on a slower one.
 */
export async function fetchOverpass(
  bbox: Bbox,
  opts: FetchOptions = {},
): Promise<OsmFile> {
  const query = overpassQuery(bbox);
  const endpoints =
    opts.endpoints ??
    (typeof window === "undefined" ? OVERPASS_ENDPOINTS : BROWSER_ENDPOINTS);
  const attempts: Attempt[] = [];
  const startedAt = Date.now();

  for (const [i, endpoint] of endpoints.entries()) {
    // Asking the same mirror twice in a row only helps if it gets a breath.
    if (i > 0 && endpoint === endpoints[i - 1]) await wait(RETRY_DELAY_MS);

    // Never start an attempt there is no useful time left for.
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (i > 0 && remaining < MIN_ATTEMPT_MS) break;

    opts.onProgress?.({
      phase: "trying",
      endpoint,
      index: i,
      total: endpoints.length,
      retry: endpoints.slice(0, i).includes(endpoint),
    });
    try {
      const json = await ask(endpoint, query, opts, remaining);
      // The importer projects to local metres about the box centre, and nothing
      // else in the response says where on earth it is.
      json.bbox = bbox;
      return json;
    } catch (err) {
      // An abort is the user's decision, not a mirror being down.
      if (err instanceof Error && err.name === "AbortError") throw err;
      const kind = err instanceof AttemptError ? err.kind : "unreachable";
      const error = reason(err);
      attempts.push({ endpoint, error, kind });
      opts.onProgress?.({ phase: "failed", endpoint, error });

      /*
       * A box the server gave up on is a box every server will give up on.
       * Trying three more mirrors takes three more minutes to learn nothing.
       */
      if (kind === "tooBig") break;
    }
  }

  throw new OverpassError("no OpenStreetMap mirror answered", attempts);
}
