import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LevelDef } from "../src/sim/types.ts";
import type { OsmFile } from "../src/levels/osm/import.ts";
import type { Bbox } from "../src/levels/osm/overpass.ts";

/**
 * The world store: OpenStreetMap, once, on disk.
 *
 * The app fetched every area straight from Overpass, which is fine for a
 * six-hundred-metre junction and hopeless for a borough — a 5km import is nine
 * round trips and minutes of waiting, and Brooklyn is seven of those. This holds
 * the same data locally so an area costs a disk read.
 *
 * Two layers, and the split is forced rather than chosen:
 *
 *   - `tiles` is raw Overpass output on a fixed lattice. It is the source of
 *     truth, because it is the only thing that survives the importer changing.
 *   - `levels` is compiled `LevelDef`s keyed by the box that was asked for. It
 *     is what the client actually gets, so the browser never compiles anything.
 *
 * What is *not* here is a compiled fragment per tile, which is the obvious
 * design and does not work: `importOsm` merges junction clusters and collapses
 * degree-2 chains in passes that run over the whole box at once. A junction
 * straddling a tile edge would merge on one side and not the other, and a street
 * crossing one would come back as two roads meeting at a node that is not an
 * intersection. So tiles are stored raw and compiled in whatever combination an
 * area actually asks for.
 *
 * `node:sqlite` rather than a driver, and `node:http` rather than a framework:
 * two tables and half a dozen statements do not justify a dependency, which is
 * the same call `areaDb.ts` makes in the browser.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Gitignored — this is a cache of somebody else's data, not source. */
export const DB_PATH = process.env.WORLD_DB ?? resolve(ROOT, "data/worlds.db");

/**
 * The lattice step, in degrees.
 *
 * A *fixed* lattice, deliberately — and note that `tileCache.ts` in the browser
 * concluded the opposite for good reasons that do not apply here. There, tiles
 * were fetched on demand during an import somebody was waiting on, so a lattice
 * cell reaching past the requested box was ground fetched at five seconds a
 * square kilometre to deliver nothing. Here the tiles are fetched once, offline,
 * before anyone asks; over-covering the edge of a borough costs a few minutes of
 * a run that happens once, and buys stable cell identities so that every area
 * anybody ever imports shares them.
 *
 * Sized to stay inside `TILE_HALF_METRES` (900m half, so 1.8km a side) at the
 * latitudes this is aimed at. At 40.65° north these are 1.78km by 1.69km. Nearer
 * the equator a column reaches 2.2km, which the server may refuse — and that is
 * survivable, because `fetchOverpass` quarters a box it is told is too big.
 */
export const LAT_STEP = 0.016;
export const LON_STEP = 0.02;

/**
 * Bumped when `overpassQuery` changes what it asks for.
 *
 * Same contract as the browser tile cache: a stored tile is only as good as the
 * query that produced it, and a tag added to the query is otherwise invisible on
 * every tile already on disk.
 */
export const QUERY_VERSION = 1;

/**
 * Bumped when `importOsm` changes what it builds.
 *
 * Only invalidates `levels`. Raw tiles are untouched, which is the whole reason
 * they are kept: a recompile of the entire borough is minutes of local CPU
 * instead of hours of somebody else's server.
 */
export const IMPORTER_VERSION = 1;

export type Cell = { i: number; j: number };

/** The lattice cell a coordinate falls in. */
export function cellAt(lat: number, lon: number): Cell {
  return { i: Math.floor(lat / LAT_STEP), j: Math.floor(lon / LON_STEP) };
}

export function cellBbox(cell: Cell): Bbox {
  return {
    south: cell.i * LAT_STEP,
    north: (cell.i + 1) * LAT_STEP,
    west: cell.j * LON_STEP,
    east: (cell.j + 1) * LON_STEP,
  };
}

export function cellKey(cell: Cell): string {
  return `v${QUERY_VERSION}/${cell.i}/${cell.j}`;
}

/**
 * Every lattice cell a box touches.
 *
 * Inclusive of the cells the edges land in, so the returned set always covers
 * the box completely — the importer clips back to the box afterwards, and a way
 * that only reaches into the area still has to be there to be clipped.
 */
export function cover(bbox: Bbox): Cell[] {
  const lo = cellAt(bbox.south, bbox.west);
  const hi = cellAt(bbox.north, bbox.east);
  const cells: Cell[] = [];
  for (let i = lo.i; i <= hi.i; i++) {
    for (let j = lo.j; j <= hi.j; j++) cells.push({ i, j });
  }
  return cells;
}

/** The key a compiled level is stored under. Rounded like `tileKey`, and why. */
export function levelKey(lat: number, lon: number, radius: number): string {
  return `v${IMPORTER_VERSION}/${lat.toFixed(6)}/${lon.toFixed(6)}/${Math.round(radius)}`;
}

export type TileRow = { key: string; fetchedAt: number; elements: OsmFile["elements"] };

export type AreaRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
  builtAt: number;
  bytes: number;
};

let db: DatabaseSync | null = null;

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  /*
   * WAL so the ingest can keep writing while the server reads. Without it a
   * bulk run holds a write lock for hours and every request behind it fails,
   * which is exactly the shape of "why is the app broken, I'm only downloading".
   */
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  /*
   * Fold the write-ahead log back into the database file on the way out.
   *
   * Without this the ingest tool's `process.exit(0)` leaves the whole run
   * sitting in `worlds.db-wal` — after the Brooklyn test above, a 4 kB
   * `worlds.db` beside a 2 MB WAL. Nothing is lost, because the WAL is part of
   * the database, but only if it travels with it: copy or back up `worlds.db`
   * alone and two hours of ingest silently becomes an empty store.
   *
   * On `exit` rather than at each call site, because there are four of them —
   * `--status`, `--help`, a completed run, and a SIGINT — and the one that would
   * get forgotten is the one that matters.
   */
  process.once("exit", () => {
    try {
      db?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db?.close();
    } catch {
      /* Losing the checkpoint is not worth a non-zero exit status. */
    }
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS tiles (
      key        TEXT PRIMARY KEY,
      i          INTEGER NOT NULL,
      j          INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      elements   BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tiles_ij ON tiles (i, j);

    CREATE TABLE IF NOT EXISTS levels (
      key      TEXT PRIMARY KEY,
      lat      REAL NOT NULL,
      lon      REAL NOT NULL,
      radius   REAL NOT NULL,
      built_at INTEGER NOT NULL,
      level    BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS areas (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      lat       REAL NOT NULL,
      lon       REAL NOT NULL,
      radius    REAL NOT NULL,
      level_key TEXT NOT NULL
    );
  `);
  return db;
}

/*
 * Everything is stored gzipped. An Overpass tile of dense city is a few
 * megabytes of JSON that is mostly repeated tag keys, and a compiled level is
 * tens of megabytes of coordinate arrays; both come down by roughly eight to
 * one, which is the difference between a borough that fits on disk comfortably
 * and one that does not. The compiled blobs are also served straight out to the
 * client still compressed — see `server/index.ts`.
 */
function pack(value: unknown): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}

function unpack<T>(blob: Uint8Array): T {
  return JSON.parse(gunzipSync(blob).toString()) as T;
}

// ---------------------------------------------------------------- raw tiles

export function readTile(key: string): OsmFile["elements"] | null {
  const row = open()
    .prepare("SELECT elements FROM tiles WHERE key = ?")
    .get(key) as { elements: Uint8Array } | undefined;
  return row ? unpack<OsmFile["elements"]>(row.elements) : null;
}

export function hasTile(key: string): boolean {
  return open().prepare("SELECT 1 FROM tiles WHERE key = ?").get(key) !== undefined;
}

export function writeTile(cell: Cell, elements: OsmFile["elements"]): void {
  open()
    .prepare(
      `INSERT INTO tiles (key, i, j, fetched_at, elements) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at,
                                      elements   = excluded.elements`,
    )
    .run(cellKey(cell), cell.i, cell.j, Date.now(), pack(elements));
}

export function tileStats(): { count: number; bytes: number } {
  const row = open()
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(elements)), 0) AS bytes FROM tiles")
    .get() as { count: number; bytes: number };
  return row;
}

// ----------------------------------------------------------- compiled levels

/**
 * A compiled level, still gzipped.
 *
 * Handed back compressed because that is how it goes out over the wire — a
 * borough cell is tens of megabytes raw, and decompressing it here only to have
 * the response compress it again is the single most expensive thing this server
 * could be made to do.
 */
export function readLevelGzip(key: string): Uint8Array | null {
  const row = open()
    .prepare("SELECT level FROM levels WHERE key = ?")
    .get(key) as { level: Uint8Array } | undefined;
  return row?.level ?? null;
}

export function writeLevel(
  key: string,
  lat: number,
  lon: number,
  radius: number,
  level: LevelDef,
): number {
  const blob = pack(level);
  open()
    .prepare(
      `INSERT INTO levels (key, lat, lon, radius, built_at, level) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET built_at = excluded.built_at,
                                      level    = excluded.level`,
    )
    .run(key, lat, lon, radius, Date.now(), blob);
  return blob.length;
}

// ------------------------------------------------------------ curated areas

/** Register a prebaked area so the app can offer it by name. */
export function putArea(area: Omit<AreaRow, "builtAt" | "bytes">, levelKey: string): void {
  open()
    .prepare(
      `INSERT INTO areas (id, name, lat, lon, radius, level_key) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name      = excluded.name,
                                     lat       = excluded.lat,
                                     lon       = excluded.lon,
                                     radius    = excluded.radius,
                                     level_key = excluded.level_key`,
    )
    .run(area.id, area.name, area.lat, area.lon, area.radius, levelKey);
}

/**
 * Every prebaked area, with the size of the download it implies.
 *
 * Joined against `levels` rather than listed on its own so an area whose level
 * was invalidated by an importer bump simply disappears from the list, instead
 * of being offered and then 404ing after somebody picks it.
 */
export function listAreas(): AreaRow[] {
  return open()
    .prepare(
      `SELECT a.id, a.name, a.lat, a.lon, a.radius,
              l.built_at AS builtAt, LENGTH(l.level) AS bytes
         FROM areas a
         JOIN levels l ON l.key = a.level_key
        ORDER BY a.name`,
    )
    .all() as unknown as AreaRow[];
}

export function areaById(id: string): (AreaRow & { levelKey: string }) | null {
  const row = open()
    .prepare(
      `SELECT a.id, a.name, a.lat, a.lon, a.radius, a.level_key AS levelKey,
              l.built_at AS builtAt, LENGTH(l.level) AS bytes
         FROM areas a
         JOIN levels l ON l.key = a.level_key
        WHERE a.id = ?`,
    )
    .get(id) as unknown as (AreaRow & { levelKey: string }) | undefined;
  return row ?? null;
}
