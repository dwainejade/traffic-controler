import type { OsmFile } from "./import";
import type { Bbox } from "./overpass";

/**
 * Overpass responses, kept per tile so nothing is ever fetched twice.
 *
 * Two things make this worth the storage. The first is failure: a 5km import is
 * nine round trips and three minutes, and until now a mirror turning us away on
 * the last one threw away everything the first eight returned. The second is
 * that areas overlap — growing an import, nudging its centre, or re-importing
 * somewhere you have already been all re-fetched ground that had not changed.
 *
 * Tiles are cut from the box that was asked for, and keyed by that box — see
 * `tileKey` for why a shared global lattice, which is the obvious way to let
 * different areas reuse each other's tiles, turned out to cost far more in
 * over-fetching than it saved.
 */

const DB_NAME = "traffic-controler-tiles";
const DB_VERSION = 1;
const STORE = "tiles";

/**
 * Bumped whenever `overpassQuery` changes what it asks for.
 *
 * A cached tile is only as good as the query that produced it, and a tag added
 * to the query would otherwise be invisible on every area already stored —
 * which is exactly the kind of divergence that takes a day to spot.
 */
const QUERY_VERSION = 1;

/** How long a tile is trusted. OSM moves; a city does not move fast. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tiles kept before the oldest are dropped. A dense 1.8km tile runs to a few
 * megabytes, so this is a storage budget as much as a count.
 */
const MAX_TILES = 80;

/**
 * A tile's cache key: its own box, rounded.
 *
 * Deliberately *not* a global lattice, which is what this was first. Cells on a
 * fixed lattice have stable identities and so can be shared between overlapping
 * imports, which sounds strictly better and measures much worse: the requested
 * area almost never lines up with the lattice, so the edges over-fetch. At a
 * 1.8km cell a 5km import covered 51.6 km² to deliver 25, and a 600m one covered
 * 6.5 km² to deliver 0.4 — sixteen times the ground, at about five seconds a
 * square kilometre.
 *
 * Keying on the tile's own box gives up sharing between *different* areas and
 * keeps the reuse that actually matters: a retry after a failure, and
 * re-importing somewhere you already have. Those are the expensive cases — an
 * import is minutes long and used to throw all of it away on the last piece —
 * and they hit every tile exactly.
 *
 * Six decimal places is about a tenth of a metre, far finer than any two runs of
 * the same request could differ by and far coarser than float noise.
 */
export function tileKey(bbox: Bbox): string {
  const at = (n: number) => n.toFixed(6);
  return `v${QUERY_VERSION}/${at(bbox.south)}/${at(bbox.west)}/${at(bbox.north)}/${at(bbox.east)}`;
}

type Stored = {
  key: string;
  fetchedAt: number;
  elements: OsmFile["elements"];
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" }).createIndex(
          "fetchedAt",
          "fetchedAt",
        );
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB refused"));
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/**
 * A cached tile, or null.
 *
 * Every failure here is a miss rather than an error. A cache that can take the
 * import down with it is worse than no cache: private-mode Safari refuses to
 * open a database at all, and the only correct response to that is to fetch.
 */
export async function readTile(key: string): Promise<OsmFile["elements"] | null> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const hit = (await promisify(store.get(key))) as Stored | undefined;
    if (!hit) return null;
    if (Date.now() - hit.fetchedAt > MAX_AGE_MS) return null;
    return hit.elements;
  } catch {
    return null;
  }
}

/** Store a tile. Silent on failure — a tile that will not cache still imported. */
export async function writeTile(
  key: string,
  elements: OsmFile["elements"],
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await promisify(store.put({ key, fetchedAt: Date.now(), elements }));

    // Evict oldest first, so the cache stays useful for where you are working
    // now rather than wherever you happened to start.
    const count = await promisify(store.count());
    if (count > MAX_TILES) {
      const cursor = store.index("fetchedAt").openCursor();
      let excess = count - MAX_TILES;
      await new Promise<void>((resolve) => {
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || excess <= 0) return resolve();
          c.delete();
          excess--;
          c.continue();
        };
        cursor.onerror = () => resolve();
      });
    }
  } catch {
    /* A tile that would not store is not worth failing an import over. */
  }
}

/** Drop everything. Exposed for the dev console and for a storage reset. */
export async function clearTiles(): Promise<void> {
  try {
    const db = await openDb();
    await promisify(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } catch {
    /* Nothing to clear if it will not open. */
  }
}
