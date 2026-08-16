#!/usr/bin/env node
/**
 * Fill the world store, once, so the app never waits on Overpass again.
 *
 *   npm run world:ingest                    # fetch Brooklyn's tiles, then bake it
 *   npm run world:ingest -- --fetch         # tiles only
 *   npm run world:ingest -- --bake          # compile only, from tiles already here
 *   npm run world:ingest -- --status        # what is on disk
 *   npm run world:ingest -- --region manhattan
 *   npm run world:ingest -- --bbox 40.66 -74.01 40.70 -73.96 --name "Red Hook"
 *
 * Two phases, and they are separable on purpose. Fetching is hours of somebody
 * else's server and is the part you do not want to repeat; baking is minutes of
 * local CPU and is the part you *will* repeat, every time the importer changes.
 * That is the whole reason raw tiles are kept alongside the compiled levels.
 *
 * Both phases resume. A tile is written the moment it lands and a baked cell the
 * moment it compiles, so an interrupted run — a rate limit, a closed laptop —
 * picks up where it stopped rather than starting the borough again.
 *
 * Expect the Brooklyn fetch to take roughly two hours. It is about 130 lattice
 * tiles, paced deliberately: the public Overpass instance grants an address a
 * couple of slots and answers 429 past them, and getting the address limited a
 * hundred tiles in is the only failure here that actually costs anything.
 */

import { World } from "../src/sim/world.ts";
import { boxAround, OverpassError, scaleAt, type Bbox } from "../src/levels/osm/overpass.ts";
import {
  DB_PATH,
  levelKey,
  listAreas,
  open,
  putArea,
  tileStats,
  writeLevel,
} from "../server/db.ts";
import { buildLevel, fillTiles, missingCells } from "../server/worlds.ts";

// ------------------------------------------------------------------- regions

/**
 * Places worth having whole. Brooklyn is the one this was built for; the rest
 * are here because a borough boundary is an awkward thing to type twice.
 */
const REGIONS: Record<string, { name: string; bbox: Bbox }> = {
  brooklyn: {
    name: "Brooklyn",
    bbox: { south: 40.5595, west: -74.0425, north: 40.7395, east: -73.8330 },
  },
  manhattan: {
    name: "Manhattan",
    bbox: { south: 40.6980, west: -74.0210, north: 40.8820, east: -73.9070 },
  },
  queens: {
    name: "Queens",
    bbox: { south: 40.5410, west: -73.9630, north: 40.8010, east: -73.7000 },
  },
};

/**
 * Half-extent of one baked cell, in metres.
 *
 * This is the unit the app hands to the simulation, so it is bounded by what is
 * playable rather than by what will fetch: 1250 gives a 2.5km square, a quarter
 * of the 5km the importer allows and about as much city as reads as one place.
 * Brooklyn comes out as roughly sixty of them.
 */
const BAKE_RADIUS = 1250;

// ----------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
/**
 * A flag's values: everything up to the next flag.
 *
 * Stops at the first `--`, rather than filtering them out of the whole tail —
 * which looks equivalent and is not, because it silently collects the *next*
 * flag's values too, and `--bbox` then sees six numbers and rejects four good
 * ones. Only `--` counts as a flag boundary, since a bare `-` starts every
 * western longitude this will ever be given.
 */
const valuesAfter = (flag: string): string[] => {
  const i = argv.indexOf(flag);
  if (i === -1) return [];
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};
const value = (flag: string): string | undefined => valuesAfter(flag)[0];

if (has("--help") || has("-h")) {
  console.log(
    [
      "usage: node tools/ingest.ts [options]",
      "",
      "  --region <name>          brooklyn (default), manhattan, queens",
      "  --bbox <s> <w> <n> <e>   an explicit box instead of a region",
      "  --name <label>           display name for a --bbox run",
      "  --fetch                  fetch tiles, do not compile",
      "  --bake                   compile from tiles already stored",
      "  --radius <metres>        half-extent of a baked cell (default 1250)",
      "  --status                 report what is on disk and exit",
      "",
      `store: ${DB_PATH}`,
    ].join("\n"),
  );
  process.exit(0);
}

open();

if (has("--status")) {
  const tiles = tileStats();
  const areas = listAreas();
  console.log(`store   ${DB_PATH}`);
  console.log(`tiles   ${tiles.count} (${mb(tiles.bytes)})`);
  console.log(`areas   ${areas.length} baked`);
  for (const a of areas) {
    console.log(`  ${a.id.padEnd(28)} ${a.name.padEnd(22)} ${mb(a.bytes).padStart(9)}`);
  }
  process.exit(0);
}

const regionKey = (value("--region") ?? "brooklyn").toLowerCase();
const explicit = valuesAfter("--bbox").map(Number);

let label: string;
let bbox: Bbox;

if (explicit.length > 0) {
  if (explicit.length !== 4 || explicit.some((n) => !Number.isFinite(n))) {
    fail("--bbox needs four numbers: south west north east");
  }
  const [south, west, north, east] = explicit;
  if (south >= north || west >= east) fail("--bbox must be south < north and west < east");
  bbox = { south, west, north, east };
  label = value("--name") ?? "Area";
} else {
  const region = REGIONS[regionKey];
  if (!region) fail(`unknown region "${regionKey}" — try ${Object.keys(REGIONS).join(", ")}`);
  bbox = region.bbox;
  label = region.name;
}

const radius = Number(value("--radius") ?? BAKE_RADIUS);
if (!Number.isFinite(radius) || radius < 200) fail("--radius must be at least 200 metres");

/* Neither flag means both phases, which is what you want the first time. */
const doFetch = has("--fetch") || !has("--bake");
const doBake = has("--bake") || !has("--fetch");

// --------------------------------------------------------------------- main

const cancel = new AbortController();
process.on("SIGINT", () => {
  console.log("\nstopping — everything fetched so far is stored, rerun to resume");
  cancel.abort();
});

const started = Date.now();

if (doFetch) await fetchPhase();
if (doBake) bakePhase();

console.log(`\ndone in ${elapsed()}`);
process.exit(0);

// -------------------------------------------------------------------- phases

async function fetchPhase(): Promise<void> {
  const outstanding = missingCells(bbox).length;
  console.log(`${label}: ${outstanding} tile(s) to fetch — ${km2(bbox)} km²`);
  if (outstanding === 0) {
    console.log("  all tiles already stored");
    return;
  }

  try {
    const { fetched, cached } = await fillTiles(bbox, {
      signal: cancel.signal,
      onProgress: (p) => {
        const at = `${String(p.index + 1).padStart(4)}/${p.total}`;
        if (p.source === "cache") return; // Nothing happened; do not scroll for it.
        if (p.source === "backoff") {
          /*
           * Said out loud, because the alternative is ten silent minutes that
           * are indistinguishable from a hang — and the natural response to that
           * is to kill a run that was about to recover on its own.
           */
          console.log(
            `  ${at}  every mirror busy — waiting ${Math.round((p.waitMs ?? 0) / 1000)}s before retrying  ${elapsed()}`,
          );
          return;
        }
        console.log(`  ${at}  cell ${p.cell.i},${p.cell.j}  ${p.bytes} elements  ${elapsed()}`);
      },
    });
    console.log(`  fetched ${fetched}, already had ${cached}`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") process.exit(130);
    if (err instanceof OverpassError) {
      console.error("\nOverpass gave up:");
      for (const a of err.attempts) console.error(`  ${a.kind}  ${a.endpoint}  ${a.error}`);
      console.error("\nEverything fetched so far is stored. Wait a while and rerun to resume.");
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Compile the region into playable cells.
 *
 * Each cell is checked by building a `World` from it before it is registered,
 * for the same reason the in-app importer does: `App` builds one
 * unconditionally, so a level the simulation cannot run would white-screen the
 * app — and a bad cell in a baked borough is far worse than a bad import,
 * because nobody is standing there watching it happen.
 */
function bakePhase(): void {
  const cells = bakeGrid(bbox, radius);
  console.log(`\nbaking ${label}: ${cells.length} cell(s) at ${radius}m`);

  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const [n, cell] of cells.entries()) {
    if (cancel.signal.aborted) break;
    const at = `${String(n + 1).padStart(4)}/${cells.length}`;

    if (missingCells(boxAround(cell.lat, cell.lon, radius)).length > 0) {
      skipped++;
      continue; // Outside what was fetched. Not an error: the grid overhangs.
    }

    try {
      const level = buildLevel({
        id: cell.id,
        name: cell.name,
        lat: cell.lat,
        lon: cell.lon,
        radius,
      });

      /*
       * An empty cell is normal and not worth storing. A 2.5km square of
       * Brooklyn that is all cemetery, all water, or all Floyd Bennett Field
       * compiles perfectly happily into a level with nothing in it, and
       * offering that by name is offering a blank screen.
       */
      if (level.roads.length === 0 || !level.nodes.some((nd) => nd.kind === "source")) {
        skipped++;
        continue;
      }

      new World(level).warmup(1);

      const key = levelKey(cell.lat, cell.lon, radius);
      const bytes = writeLevel(key, cell.lat, cell.lon, radius, level);
      putArea({ id: cell.id, name: cell.name, lat: cell.lat, lon: cell.lon, radius }, key);

      built++;
      console.log(
        `  ${at}  ${cell.name.padEnd(20)} ${String(level.roads.length).padStart(5)} roads  ${mb(bytes).padStart(9)}`,
      );
    } catch (err) {
      failed++;
      console.error(`  ${at}  ${cell.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`  baked ${built}, skipped ${skipped}, failed ${failed}`);
}

// -------------------------------------------------------------------- helpers

type BakeCell = { id: string; name: string; lat: number; lon: number };

/**
 * Lay playable cells over a region, edge to edge.
 *
 * Named by grid position — `Brooklyn C4` — rather than by neighbourhood, which
 * would be nicer and would need a gazetteer and a rule for the cells that
 * straddle three of them. The row letter runs north to south so reading the list
 * top to bottom walks down the map.
 */
function bakeGrid(box: Bbox, half: number): BakeCell[] {
  const mid = (box.south + box.north) / 2;
  const { perLat, perLon } = scaleAt(mid);
  const side = half * 2;

  const rows = Math.max(1, Math.round(((box.north - box.south) * perLat) / side));
  const cols = Math.max(1, Math.round(((box.east - box.west) * perLon) / side));

  const stepLat = (box.north - box.south) / rows;
  const stepLon = (box.east - box.west) / cols;

  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const cells: BakeCell[] = [];

  /*
   * A grid of one is not a grid. Baking a single area around a place you chose
   * deliberately and having it come back "Rogers Avenue A1" reads like the
   * first of a series that does not exist.
   */
  const single = rows === 1 && cols === 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const row = String.fromCharCode(65 + r); // A at the top.
      const tag = `${row}${c + 1}`;
      cells.push({
        id: single ? `world_${slug}` : `world_${slug}_${tag.toLowerCase()}`,
        name: single ? label : `${label} ${tag}`,
        // North to south, so A is the top row on screen.
        lat: box.north - (r + 0.5) * stepLat,
        lon: box.west + (c + 0.5) * stepLon,
      });
    }
  }
  return cells;
}

function km2(box: Bbox): string {
  const { perLat, perLon } = scaleAt((box.south + box.north) / 2);
  const area = (((box.north - box.south) * perLat) / 1000) * (((box.east - box.west) * perLon) / 1000);
  return area.toFixed(area < 10 ? 1 : 0);
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} kB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function elapsed(): string {
  const s = Math.round((Date.now() - started) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
