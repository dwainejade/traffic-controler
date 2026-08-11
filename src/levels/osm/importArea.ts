import { World } from "../../sim/world";
import { addArea, newAreaId, useLevels } from "../registry";
import type { SavedArea } from "../store/areaDb";
import { importOsm } from "./import";
import { boxAround, fetchOverpass, OverpassError } from "./overpass";

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
export const RADIUS_MAX = 600;
export const RADIUS_DEFAULT = 300;
/** Past this it is slow enough to be worth warning about first. */
export const RADIUS_WARN = 450;

export type ImportPhase =
  | { kind: "idle" }
  | { kind: "fetching"; endpoint: string; index: number; total: number }
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
    file = await fetchOverpass(bbox, {
      signal: opts.signal,
      onProgress: (p) => {
        if (p.phase === "trying") {
          opts.onPhase?.({
            kind: "fetching",
            endpoint: host(p.endpoint),
            index: p.index,
            total: p.total,
          });
        }
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (err instanceof OverpassError) {
      const timedOut = err.attempts.some((a) => /timed out|out of memory/i.test(a.error));
      throw new ImportError(
        timedOut
          ? "That area is too big for the map server. Try a smaller radius."
          : "Every OpenStreetMap mirror is busy. Try again in a minute.",
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
  await addArea(area);
  return area;
}
