import type { LevelDef } from "../src/sim/types.ts";
import { importOsm, type OsmFile } from "../src/levels/osm/import.ts";
import {
  boxAround,
  fetchOverpass,
  OverpassError,
  type Bbox,
} from "../src/levels/osm/overpass.ts";
import {
  cellBbox,
  cellKey,
  cover,
  hasTile,
  levelKey,
  readLevelGzip,
  readTile,
  writeLevel,
  writeTile,
  type Cell,
} from "./db.ts";

/**
 * Turning stored tiles into a playable level.
 *
 * The one place that knows both halves of the store — that a level is compiled
 * from whichever raw tiles its box happens to touch — so the ingest tool and the
 * HTTP server cannot drift apart about how an area is built.
 */

const UA = "traffic-controler/0.1 (world store ingest)";

/** Politeness, and self-preservation: the public instance sheds load at 429. */
const BETWEEN_FETCHES_MS = 1_500;

/**
 * Waits after a tile every mirror turned away, in ms.
 *
 * The single most important number here, because of what this loop is: a run
 * over a borough is a hundred-odd tiles and a couple of hours, and without this
 * one busy minute anywhere in it ends the whole job. That is not hypothetical —
 * it is what the first Rogers Avenue run did, losing four tiles to a wave of
 * 504s that had passed by the time anybody looked.
 *
 * Long and patient rather than eager, and deliberately unlike the browser's
 * `TILE_BACKOFF_MS`. There, somebody is watching a progress bar and would rather
 * be told it failed; here nobody is watching, the work is expensive to redo, and
 * a mirror shedding load wants minutes rather than seconds. Fifteen minutes
 * across five attempts costs nothing against a two-hour run.
 */
const BUSY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether an Overpass failure was every mirror shedding load, not a bad box. */
function isBusy(err: unknown): boolean {
  return (
    err instanceof OverpassError &&
    err.attempts.length > 0 &&
    err.attempts.some((a) => a.kind === "busy")
  );
}

export type FillProgress = {
  cell: Cell;
  index: number;
  total: number;
  source: "cache" | "network" | "backoff";
  bytes?: number;
  /** `backoff` only: how long we are about to wait before asking again. */
  waitMs?: number;
};

/**
 * Make sure every cell covering `bbox` is on disk, fetching what is missing.
 *
 * Sequential and paced, unlike the browser importer's two-at-a-time. Nobody is
 * watching this: it runs once, offline, over a whole borough, and the thing that
 * ruins it is not slowness but getting the address rate-limited a hundred tiles
 * in. Each tile is written the moment it lands, so an interrupted run resumes
 * where it stopped rather than starting the borough again.
 */
export async function fillTiles(
  bbox: Bbox,
  opts: { signal?: AbortSignal; onProgress?: (p: FillProgress) => void } = {},
): Promise<{ fetched: number; cached: number }> {
  const cells = cover(bbox);
  let fetched = 0;
  let cached = 0;

  for (const [index, cell] of cells.entries()) {
    opts.signal?.throwIfAborted();

    if (hasTile(cellKey(cell))) {
      cached++;
      opts.onProgress?.({ cell, index, total: cells.length, source: "cache" });
      continue;
    }

    if (fetched > 0) await wait(BETWEEN_FETCHES_MS);

    /*
     * Retry this one tile through the backoff before giving up on the run. Only
     * `busy` is retried: a box the server ran and abandoned is `tooBig` and will
     * be abandoned again a minute later, and an unreachable mirror is not going
     * to become reachable by asking the same way — those two still fail fast, so
     * a genuinely broken request does not sit here for fifteen minutes.
     */
    let file;
    for (let attempt = 0; ; attempt++) {
      try {
        file = await fetchOverpass(cellBbox(cell), {
          signal: opts.signal,
          userAgent: UA,
        });
        break;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const backoff = BUSY_BACKOFF_MS[attempt];
        if (!isBusy(err) || backoff === undefined) throw err;
        opts.onProgress?.({
          cell,
          index,
          total: cells.length,
          source: "backoff",
          waitMs: backoff,
        });
        await wait(backoff);
        opts.signal?.throwIfAborted();
      }
    }

    writeTile(cell, file.elements);
    fetched++;
    opts.onProgress?.({
      cell,
      index,
      total: cells.length,
      source: "network",
      bytes: file.elements.length,
    });
  }

  return { fetched, cached };
}

/** Which cells covering a box are not on disk yet. */
export function missingCells(bbox: Bbox): Cell[] {
  return cover(bbox).filter((c) => !hasTile(cellKey(c)));
}

/**
 * Every stored element covering a box, deduplicated, as one Overpass response.
 *
 * Merging is a matter of dropping duplicates rather than joining anything, and
 * that is a property of the query rather than luck — `way(bbox)` returns whole
 * ways that merely touch a cell and `>` pulls in all of their nodes, so a street
 * crossing a lattice line comes back complete from either side. Keyed on
 * `type/id` because a node and a way may share a number.
 *
 * `bbox` on the result is the box that was *asked for*, not the cells that were
 * read: the importer projects about its centre and clips to it, and handing it
 * the lattice extent instead would centre the map on the wrong point and leave
 * the level reaching a kilometre past its own ground card.
 */
export function assembleFile(bbox: Bbox): OsmFile {
  const seen = new Set<string>();
  const elements: OsmFile["elements"] = [];

  for (const cell of cover(bbox)) {
    const part = readTile(cellKey(cell));
    if (!part) continue;
    for (const el of part) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }

  return { elements, bbox };
}

export class MissingTiles extends Error {
  cells: Cell[];

  constructor(cells: Cell[]) {
    super(`${cells.length} tile(s) not in the store`);
    this.name = "MissingTiles";
    this.cells = cells;
  }
}

export type BuildInput = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Half the square's side, in metres. */
  radius: number;
  demand?: number;
};

/**
 * Compile an area from stored tiles.
 *
 * Throws `MissingTiles` rather than reaching for Overpass. Whether a gap is
 * worth a network round trip is a policy question, and the two callers answer it
 * differently — the ingest tool fills the gap, the server refuses and says so,
 * because a request that quietly takes four minutes is worse than one that fails
 * in a millisecond with a list of what is missing.
 */
export function buildLevel(input: BuildInput): LevelDef {
  const bbox = boxAround(input.lat, input.lon, input.radius);

  const missing = missingCells(bbox);
  if (missing.length > 0) throw new MissingTiles(missing);

  return importOsm(assembleFile(bbox), {
    id: input.id,
    name: input.name,
    demand: input.demand,
  });
}

/**
 * A compiled level for this box, from the cache if it is there.
 *
 * Returned gzipped, because that is the form it is stored in and the form it
 * goes out in; nothing between the disk and the client has any reason to look
 * inside it.
 */
export function levelGzip(input: BuildInput): { blob: Uint8Array; built: boolean } {
  const key = levelKey(input.lat, input.lon, input.radius);

  const hit = readLevelGzip(key);
  if (hit) return { blob: hit, built: false };

  const level = buildLevel(input);
  writeLevel(key, input.lat, input.lon, input.radius, level);

  /*
   * Read back rather than keeping the blob `writeLevel` made. One statement,
   * and it means there is exactly one path by which a level reaches a client —
   * so a bug in storage shows up on the first request instead of on the first
   * request after a restart.
   */
  const stored = readLevelGzip(key);
  if (!stored) throw new Error(`level ${key} would not store`);
  return { blob: stored, built: true };
}
