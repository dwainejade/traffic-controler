#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DB_PATH, areaById, listAreas, open, readLevelGzip, tileStats } from "./db.ts";
import { levelGzip, MissingTiles, type BuildInput } from "./worlds.ts";

/**
 * The world store, over HTTP.
 *
 * Four routes and no framework, which is the same call the rest of the storage
 * code makes: `node:http` is a request object and a response object, and what a
 * framework would add here is routing for four paths.
 *
 * Everything it serves is already gzipped on disk and goes out that way
 * untouched — a baked cell is tens of megabytes of coordinates, and unpacking it
 * only to repack it would be by far the most expensive thing this process does.
 */

const PORT = Number(process.env.WORLD_PORT ?? 8787);

/**
 * The dev server, and nothing else.
 *
 * Vite proxies `/api` in development so the app's own requests are same-origin
 * and never reach this at all; the header is here for the case of pointing a
 * built app at a store running somewhere else. Kept to an explicit list rather
 * than `*` because this process reads and writes a database on somebody's
 * laptop, and `*` would let any page they happen to have open do the same.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.WORLD_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
);

/** Levels are immutable for a given box and importer version — the key says so. */
const IMMUTABLE = "public, max-age=31536000, immutable";

open();

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error(err);
    send(res, 500, { error: "internal error" });
  });
});

server.listen(PORT, () => {
  const { count, bytes } = tileStats();
  console.log(`world store on http://localhost:${PORT}`);
  console.log(`  db     ${DB_PATH}`);
  console.log(`  tiles  ${count} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  areas  ${listAreas().length} baked`);
});

// -------------------------------------------------------------------- routing

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, { error: "GET only" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  switch (url.pathname) {
    case "/api/health": {
      const { count, bytes } = tileStats();
      send(res, 200, { ok: true, tiles: count, bytes, areas: listAreas().length });
      return;
    }

    /*
     * `areas.json` is the name a static export uses, because a bucket serves
     * files and a file has an extension. The server answers to both so the app
     * has one code path and genuinely cannot tell a CDN from a host — which is
     * the only way the two deployments stay tested by the same usage.
     */
    case "/api/areas":
    case "/api/areas.json":
      /*
       * No cache header. This is the one thing that changes underneath a running
       * app — the ingest tool bakes cells into it while the server is up — and
       * it is a few kilobytes of JSON.
       */
      send(res, 200, { areas: listAreas() });
      return;

    case "/api/level":
      serveLevel(url, res);
      return;

    default: {
      /* The static export's per-level path: /api/levels/<id>.json.gz */
      const level = url.pathname.match(/^\/api\/levels\/(.+)\.json\.gz$/);
      if (level) {
        serveLevelById(decodeURIComponent(level[1]), res);
        return;
      }
      send(res, 404, { error: "no such route" });
    }
  }
}

/**
 * A compiled level, by area id or by coordinates.
 *
 * Two ways in because there are two callers. The app's area list picks a baked
 * cell by id and gets a straight blob read; the import form asks for an
 * arbitrary box, which is a cache lookup and, on a miss, a compile from stored
 * tiles — a second or two of CPU rather than the minutes it used to be.
 */
/**
 * One baked area, at the path a static export puts it.
 *
 * Sent as the raw gzip *without* a `Content-Encoding` header, matching what a
 * bucket does with an uploaded `.json.gz` by default. The app sniffs the magic
 * bytes and decompresses whatever it is handed, so both this and a CDN that
 * does set the header work — but only if this one does not quietly differ from
 * the exported files it is meant to stand in for.
 */
function serveLevelById(id: string, res: ServerResponse): void {
  const area = areaById(id);
  const blob = area && readLevelGzip(area.levelKey);
  if (!blob) {
    send(res, 404, { error: `no baked area "${id}"` });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": blob.length,
    "Cache-Control": IMMUTABLE,
  });
  res.end(blob);
}

function serveLevel(url: URL, res: ServerResponse): void {
  const id = url.searchParams.get("id");

  let input: BuildInput;
  if (id) {
    const area = areaById(id);
    if (!area) {
      send(res, 404, { error: `no baked area "${id}"` });
      return;
    }
    input = { id: area.id, name: area.name, lat: area.lat, lon: area.lon, radius: area.radius };
  } else {
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const radius = Number(url.searchParams.get("radius"));
    const name = url.searchParams.get("name")?.trim();

    if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
      send(res, 400, { error: "lat must be between -90 and 90" });
      return;
    }
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
      send(res, 400, { error: "lon must be between -180 and 180" });
      return;
    }
    if (!Number.isFinite(radius) || radius < 100 || radius > 2500) {
      send(res, 400, { error: "radius must be between 100 and 2500 metres" });
      return;
    }
    if (!name) {
      send(res, 400, { error: "name is required" });
      return;
    }

    /*
     * The client sends the id it intends to store the level under, because a
     * `LevelDef.id` is the remount key for the whole scene and the browser is
     * the only side that knows which ids are already taken.
     */
    input = { id: url.searchParams.get("levelId") ?? `world_${Date.now().toString(36)}`, name, lat, lon, radius };
  }

  let result;
  try {
    result = levelGzip(input);
  } catch (err) {
    if (err instanceof MissingTiles) {
      /*
       * 404 rather than fetching it: filling a gap is an hour of Overpass, and
       * a request that silently becomes that is worse than one that fails now
       * and says which tiles are missing. The app falls back to importing the
       * area from OpenStreetMap directly when it sees this.
       */
      send(res, 404, {
        error: "that area is not in the store",
        missing: err.cells.length,
        hint: "run: npm run world:ingest -- --bbox <s> <w> <n> <e>",
      });
      return;
    }
    throw err;
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "Content-Length": result.blob.length,
    "Cache-Control": IMMUTABLE,
  });
  res.end(result.blob);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": json.length,
  });
  res.end(json);
}
