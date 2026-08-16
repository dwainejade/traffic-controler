import type { LevelDef } from "../../sim/types";

/**
 * Areas the player imported, kept in the browser.
 *
 * What is stored is the *compiled* level, not the Overpass response it came
 * from: a response is a megabyte or two of tags nothing reads again, and
 * recompiling it on every load would cost a second of blank screen per area.
 * The coordinates are kept alongside so an area can be fetched again if the
 * importer ever changes shape.
 *
 * Raw IndexedDB rather than a wrapper — one store and three operations does not
 * justify a dependency.
 */

const DB_NAME = "traffic-controler";
const DB_VERSION = 1;
const STORE = "areas";

/**
 * Enough to keep a few cities without turning the level list into a file
 * manager. Storage is not the constraint — attention is.
 */
export const MAX_AREAS = 8;

export type SavedArea = {
  /** `osm_saved_<slug>_<base36 time>`, so it can never collide with a built-in. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Half the square's side, in metres. */
  radius: number;
  savedAt: number;
  /** The compiled level. The Overpass response is not kept. */
  level: LevelDef;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" }).createIndex(
          "savedAt",
          "savedAt",
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
 * Saved areas, oldest first.
 *
 * Resolves to an empty list rather than throwing when storage is unavailable —
 * private-mode Safari and a sandboxed Firefox both refuse `indexedDB.open`, and
 * losing the saved areas must never take the whole app down with them.
 */
export async function listAreas(): Promise<SavedArea[]> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const all = await promisify(store.getAll() as IDBRequest<SavedArea[]>);
    return all.sort((a, b) => a.savedAt - b.savedAt);
  } catch (err) {
    console.warn("saved areas unavailable:", err);
    return [];
  }
}

/**
 * Store one area. Throws if it would take the store past `MAX_AREAS` — the UI
 * blocks first, but the store should not depend on the UI being right.
 */
export async function saveArea(area: SavedArea): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);

  const existing = await promisify(store.count());
  const replacing = await promisify(store.getKey(area.id));
  if (!replacing && existing >= MAX_AREAS) {
    throw new Error(`already storing ${MAX_AREAS} areas`);
  }

  /*
   * A city-sized level is tens of megabytes once structured-cloned, which is the
   * first thing this store has held that a browser might refuse outright. The
   * failure is a `QuotaExceededError` from `put`, and left raw it surfaces to
   * the player as a stack trace over an import they just waited minutes for.
   */
  try {
    await promisify(store.put(area));
  } catch (err) {
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new Error(
        "no room left in browser storage — delete a saved area, or import a smaller one",
      );
    }
    throw err;
  }
}

export async function deleteArea(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await promisify(tx.objectStore(STORE).delete(id));
}
