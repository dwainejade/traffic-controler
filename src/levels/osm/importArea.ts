import { World } from "../../sim/world";
import { addArea, newAreaId, useLevels } from "../registry";
import type { SavedArea } from "../store/areaDb";
import { importOsm } from "./import";
import {
  boxAround,
  fetchOverpassTiled,
  OverpassError,
  TILE_HALF_METRES,
} from "./overpass";

/**
 * Importing an area from inside the app: coordinates in, playable level out.
 *
 * Everything the UI needs to know is a phase and, if it goes wrong, a sentence
 * it can show somebody. The failure modes here are all real and all different —
 * a busy mirror, a box too big for the query timeout, a spot with no streets in
 * it — and telling them apart is most of what makes this usable.
 */

/** Half the square's side, in metres. */
export const RADIUS_MIN = 100;
/**
 * Six hundred metres until the renderer and the simulation could both carry a
 * city. It is no longer either of them that sets this: 25 km² draws at over
 * 150fps and simulates inside its frame budget, and what is left is the
 * *import* — which past one Overpass tile is many round trips and minutes of
 * waiting, and which compiles a level big enough to be worth thinking about
 * before storing.
 *
 * 2500 gives a 5km square. That is 25 sub-box fetches at `TILE_HALF_METRES`,
 * which is a long wait but a bounded one, and it is about the largest area
 * anybody can usefully look at as one place.
 */
export const RADIUS_MAX = 2500;
export const RADIUS_DEFAULT = 300;
/**
 * Past this the import stops being one round trip and becomes several, so it is
 * worth saying so before somebody starts a five-minute wait by accident.
 */
export const RADIUS_WARN = TILE_HALF_METRES;

/**
 * Roughly how long an import of this radius takes, in minutes, for the warning
 * line. One round trip per tile, and the tiles are paced apart on purpose —
 * see `TILE_GAP_MS`. Deliberately pessimistic: a wait that finishes early is a
 * pleasant surprise and a wait that overruns its estimate is a bug report.
 */
export function estimatedMinutes(radius: number): number {
  const perSide = Math.max(1, Math.ceil(radius / TILE_HALF_METRES));
  return Math.max(1, Math.round((perSide * perSide * 20) / 60));
}

export type ImportPhase =
  | { kind: "idle" }
  | {
      kind: "fetching";
      endpoint: string;
      index: number;
      total: number;
      retry: boolean;
      /** Which sub-box of how many, when the area needs more than one. */
      tile?: { index: number; total: number };
    }
  | { kind: "compiling" }
  | { kind: "checking" }
  | { kind: "saving" }
  | { kind: "error"; message: string; detail?: string };

export type ImportInput = {
  name: string;
  lat: number;
  lon: number;
  /** Half the square's side, in metres. */
  radius: number;
};

export class ImportError extends Error {
  detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ImportError";
    this.detail = detail;
  }
}

/** Just the host, for a progress line that has to fit on a phone. */
function host(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function validateInput(input: ImportInput): string | null {
  if (!input.name.trim()) return "Give the area a name.";
  if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 90) {
    return "Latitude must be between -90 and 90.";
  }
  if (!Number.isFinite(input.lon) || Math.abs(input.lon) > 180) {
    return "Longitude must be between -180 and 180.";
  }
  if (!Number.isFinite(input.radius) || input.radius < RADIUS_MIN || input.radius > RADIUS_MAX) {
    return `Radius must be between ${RADIUS_MIN} and ${RADIUS_MAX} metres.`;
  }
  return null;
}

export async function importArea(
  input: ImportInput,
  opts: { signal?: AbortSignal; onPhase?: (p: ImportPhase) => void } = {},
): Promise<SavedArea> {
  const problem = validateInput(input);
  if (problem) throw new ImportError(problem);

  const name = input.name.trim();
  const bbox = boxAround(input.lat, input.lon, input.radius);

  // --- Fetch.
  let file;
  try {
    /*
     * Tiled whatever the size: `fetchOverpassTiled` hands a single-tile box
     * straight to the plain fetch, so the small imports that were working
     * before take exactly the path they always did.
     */
    let tile: { index: number; total: number } | undefined;
    file = await fetchOverpassTiled(bbox, {
      signal: opts.signal,
      onProgress: (p) => {
        if (p.phase === "tile") {
          tile = { index: p.index, total: p.total };
          return;
        }
        if (p.phase === "trying") {
          opts.onPhase?.({
            kind: "fetching",
            endpoint: host(p.endpoint),
            index: p.index,
            total: p.total,
            retry: p.retry,
            tile,
          });
        }
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (err instanceof OverpassError) {
      /*
       * The three failures need three different sentences, because they ask
       * for three different things: wait, shrink the box, or check the
       * connection. Saying "every mirror is busy" over a query that was simply
       * too large sends somebody off retrying the same doomed import.
       */
      const kinds = new Set(err.attempts.map((a) => a.kind));
      const message = kinds.has("tooBig")
        ? "That area is too big for the map server. Try a smaller radius."
        : kinds.has("busy")
          ? "OpenStreetMap is busy right now — it turned us away. Wait a minute and try again."
          : "Couldn't reach OpenStreetMap. Check your connection.";
      throw new ImportError(
        message,
        err.attempts.map((a) => `${host(a.endpoint)}: ${a.error}`).join("\n"),
      );
    }
    throw new ImportError("Could not reach OpenStreetMap.", String(err));
  }

  // --- Compile. Yield first: this is synchronous and seconds long on a city,
  // so without a paint in between the "compiling" label never appears.
  opts.onPhase?.({ kind: "compiling" });
  await new Promise((r) => setTimeout(r, 0));

  const id = newAreaId(name, useLevels.getState().levels.map((l) => l.id));

  let level;
  try {
    level = importOsm(file, { id, name });
  } catch (err) {
    throw new ImportError(
      "Couldn't build a map from that area.",
      err instanceof Error ? err.message : String(err),
    );
  }

  /*
   * An area with no streets in it compiles perfectly happily into a level with
   * nothing in it — the importer has no opinion about that — and it is only
   * downstream, where the world is built and the camera is framed, that it
   * becomes a blank screen. Catch it here, where it can still be explained.
   */
  if (level.roads.length === 0 || !level.nodes.some((n) => n.kind === "source")) {
    throw new ImportError(
      "No drivable streets there. Try a different spot, or a larger radius.",
    );
  }

  /*
   * Build a world before storing anything. `App` builds one unconditionally, so
   * a level that makes the simulation throw would white-screen the app on the
   * next render — after it had been saved, leaving a record the player cannot
   * get rid of. A one-second warmup is nothing next to the fetch.
   */
  opts.onPhase?.({ kind: "checking" });
  await new Promise((r) => setTimeout(r, 0));
  try {
    new World(level).warmup(1);
  } catch (err) {
    throw new ImportError(
      "That area builds a map the simulation can't run.",
      err instanceof Error ? err.message : String(err),
    );
  }

  opts.onPhase?.({ kind: "saving" });
  const area: SavedArea = {
    id,
    name,
    lat: input.lat,
    lon: input.lon,
    radius: input.radius,
    savedAt: Date.now(),
    level,
  };
  /*
   * Everything above this point is recoverable by trying again; this is the
   * step that can fail after minutes of fetching, so it says what went wrong
   * rather than throwing a DOMException at the form.
   */
  try {
    await addArea(area);
  } catch (err) {
    throw new ImportError(
      "Built the map, but couldn't save it.",
      err instanceof Error ? err.message : String(err),
    );
  }
  return area;
}
