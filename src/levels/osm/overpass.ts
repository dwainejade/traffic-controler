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
 * Four sets, one query:
 *   - the driveable street network, with `>` to pull in each way's nodes so we
 *     have coordinates and can spot shared nodes (which is what an intersection
 *     *is* in OSM — ways that share a node, not ways that merely cross);
 *   - traffic signals and crossings, as tagged nodes;
 *   - buildings, water (closed ponds/rivers and open sea coastlines) and green
 *     space, for real footprints instead of scatter;
 *   - shops and the amenities that behave like shops, for the names and colours
 *     over the doors. Almost all of these are nodes standing inside a building
 *     rather than the building itself, which is why they need asking for
 *     separately; `out center` covers the minority mapped as their own area, and
 *     hands back a single point for it instead of a ring the importer would only
 *     take the middle of anyway.
 *
 * `way(bbox)` returns whole ways that merely touch the box, so the geometry
 * runs past the edges; the importer clips it and puts sources on the boundary.
 */

/**
 * Amenities that put a name and a colour above a door. `shop=*` is taken
 * wholesale — every value of it is a storefront by definition — but `amenity`
 * is mostly street furniture, and a bench with a sign over it is not a thing.
 */
export const STOREFRONT_AMENITIES = [
  "restaurant",
  "fast_food",
  "cafe",
  "bar",
  "pub",
  "ice_cream",
  "pharmacy",
  "bank",
  "fuel",
  "cinema",
  "post_office",
] as const;

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

(
  node["shop"](${box});
  node["amenity"~"^(${STOREFRONT_AMENITIES.join("|")})$"](${box});
  way["shop"](${box});
  way["amenity"~"^(${STOREFRONT_AMENITIES.join("|")})$"](${box});
);
out center;
`;
}

export type FetchProgress =
  | { phase: "trying"; endpoint: string; index: number; total: number; retry: boolean }
  | { phase: "failed"; endpoint: string; error: string }
  | { phase: "received"; bytes: number }
  /** Tiled fetches only: which sub-box of how many is being asked for. */
  | { phase: "tile"; index: number; total: number };

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
  /**
   * Wall-clock ceiling for this call, mirrors and retries included. Defaults to
   * `TOTAL_BUDGET_MS`. A tiled fetch passes what is left of the whole import's
   * budget, so twenty-five sub-boxes cannot each spend two minutes failing.
   */
  budgetMs?: number;
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
  const budget = opts.budgetMs ?? TOTAL_BUDGET_MS;

  for (const [i, endpoint] of endpoints.entries()) {
    // Asking the same mirror twice in a row only helps if it gets a breath.
    if (i > 0 && endpoint === endpoints[i - 1]) await wait(RETRY_DELAY_MS);

    // Never start an attempt there is no useful time left for.
    const remaining = budget - (Date.now() - startedAt);
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

/**
 * Half-extent to ask for in one query, in metres.
 *
 * Bigger than the six hundred metres the importer used to cap at, and
 * deliberately: the binding constraint on a tiled import is not the size of any
 * one query, it is *how many* of them there are. The public Overpass instance
 * allows a couple of slots per address and answers 429 beyond that, so twenty-
 * five small requests is a far likelier failure than nine larger ones — which
 * is not a guess, it is what a four-piece Brooklyn import did on its fourth
 * piece the first time it ran.
 *
 * Nine hundred keeps a 5km box down to nine requests. Where that turns out to
 * be too much for a particular patch of city, the server says so and the tile
 * is quartered — see `fetchOverpassTiled`, which is why this can be optimistic
 * without being risky.
 */
export const TILE_HALF_METRES = 900;

/** Whole-import deadline for a tiled fetch. Generous: this is many round trips. */
const TILED_BUDGET_MS = 15 * 60_000;

/**
 * Breath between sub-boxes.
 *
 * Overpass's fair-use policy is about concurrent slots per address, and a
 * queue of back-to-back queries burns through them and starts collecting 429s.
 * Four hundred milliseconds was not a pause, it was a hammering; several
 * seconds is what makes a long import finish at all.
 */
const TILE_GAP_MS = 4_000;

/** Waits after a rate-limited tile, in ms. Backs off, then gives up. */
const TILE_BACKOFF_MS = [10_000, 25_000, 60_000];

/** How many times a tile may be quartered before we stop believing the server. */
const MAX_TILE_DEPTH = 2;

/**
 * Cut a box into pieces no larger than `TILE_HALF_METRES` a side.
 *
 * Even pieces rather than a full-size grid with a remainder strip: a 5km box
 * divides into five columns of exactly 1km rather than four of 1.2km and one of
 * 200m, and a sliver tile costs a whole round trip to fetch almost nothing.
 */
export function splitBbox(bbox: Bbox, halfMetres = TILE_HALF_METRES): Bbox[] {
  const mid = (bbox.south + bbox.north) / 2;
  const { perLat, perLon } = scaleAt(mid);
  const spanLat = (bbox.north - bbox.south) * perLat;
  const spanLon = (bbox.east - bbox.west) * perLon;

  /*
   * A metre of slack before rounding up. A box built by `boxAround` at exactly
   * the tile size comes back as 1200.0000000001m after the round trip through
   * degrees, and a bare `ceil` turns that into two requests for a box that fits
   * in one — which is every import at the old six-hundred-metre limit suddenly
   * costing twice what it used to.
   */
  const side = halfMetres * 2;
  const rows = Math.max(1, Math.ceil(spanLat / side - 1e-3));
  const cols = Math.max(1, Math.ceil(spanLon / side - 1e-3));

  const stepLat = (bbox.north - bbox.south) / rows;
  const stepLon = (bbox.east - bbox.west) / cols;

  const tiles: Bbox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        south: bbox.south + r * stepLat,
        north: bbox.south + (r + 1) * stepLat,
        west: bbox.west + c * stepLon,
        east: bbox.west + (c + 1) * stepLon,
      });
    }
  }
  return tiles;
}

/**
 * Fetch a box of any size, in pieces, and hand back one response.
 *
 * A single query for a whole city does not fail slowly — it fails after the
 * server's full sixty-second budget, with `tooBig`, having done all the work
 * and thrown it away. So anything past one tile is asked for a tile at a time.
 *
 * The seams need no stitching, and that is a property of the query rather than
 * luck: `way(bbox)` returns every way that so much as touches the box, and the
 * `>` that follows pulls in all of that way's nodes wherever on earth they are.
 * So a street crossing a tile boundary comes back *complete* from either tile,
 * and merging is a matter of dropping the duplicate rather than joining two
 * halves. Deduplication is by `type/id`, since a node and a way may share a
 * number.
 */
export async function fetchOverpassTiled(
  bbox: Bbox,
  opts: FetchOptions = {},
): Promise<OsmFile> {
  const tiles = splitBbox(bbox);
  if (tiles.length === 1) return fetchOverpass(bbox, opts);

  const startedAt = Date.now();
  const seen = new Set<string>();
  const elements: OsmFile["elements"] = [];
  const left = () => TILED_BUDGET_MS - (Date.now() - startedAt);

  /** Which failure kinds an `OverpassError` collected. */
  const kindsOf = (err: unknown) =>
    err instanceof OverpassError
      ? new Set(err.attempts.map((a) => a.kind))
      : new Set<FailureKind>();

  /**
   * One sub-box, with the two recoveries the server actually asks for.
   *
   * `busy` is a rate limit, and the answer to a rate limit is to wait rather
   * than to try somebody else — the inner fetch has already been through every
   * mirror by the time this sees it. `tooBig` is the opposite: waiting will
   * never help, and the box has to get smaller, so it is quartered and each
   * quarter asked for separately. Starting with optimistic tiles and letting
   * the server push back is what keeps a sparse 5km import to nine requests
   * while still handling the patch of city that needs thirty-six.
   */
  const fetchTile = async (tile: Bbox, depth: number): Promise<OsmFile> => {
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const remaining = left();
      if (remaining < MIN_ATTEMPT_MS) {
        throw new OverpassError("ran out of time part way through the area", []);
      }

      try {
        return await fetchOverpass(tile, { ...opts, budgetMs: remaining });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const kinds = kindsOf(err);

        if (kinds.has("tooBig") && depth < MAX_TILE_DEPTH) {
          const quarters = splitBbox(tile, tileHalfOf(tile) / 2);
          const merged: OsmFile["elements"] = [];
          for (const [q, quarter] of quarters.entries()) {
            if (q > 0) await wait(TILE_GAP_MS);
            merged.push(...(await fetchTile(quarter, depth + 1)).elements);
          }
          return { elements: merged, bbox: tile };
        }

        const backoff = TILE_BACKOFF_MS[attempt];
        if (kinds.has("busy") && backoff !== undefined && left() > backoff + MIN_ATTEMPT_MS) {
          await wait(backoff);
          continue;
        }
        throw err;
      }
    }
  };

  for (const [i, tile] of tiles.entries()) {
    if (i > 0) await wait(TILE_GAP_MS);
    opts.signal?.throwIfAborted();
    opts.onProgress?.({ phase: "tile", index: i, total: tiles.length });

    /*
     * No partial results. A city with a hole in it compiles into a network with
     * streets that stop dead, which is far worse than a failed import: it looks
     * like a map, and every route through the hole is quietly impossible.
     */
    for (const el of (await fetchTile(tile, 0)).elements) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }

  // The importer projects to local metres about the centre of this box, so it
  // must be the box that was asked for, not the last tile fetched.
  return { elements, bbox };
}

/** Half the longer side of a box, in metres — what `splitBbox` measures against. */
function tileHalfOf(bbox: Bbox): number {
  const { perLat, perLon } = scaleAt((bbox.south + bbox.north) / 2);
  return (
    Math.max(
      (bbox.north - bbox.south) * perLat,
      (bbox.east - bbox.west) * perLon,
    ) / 2
  );
}
